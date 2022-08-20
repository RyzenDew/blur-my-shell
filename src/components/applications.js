'use strict';

const { Shell, Clutter, Meta, GLib } = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const { PaintSignals } = Me.imports.effects.paint_signals;
const { ApplicationsService } = Me.imports.dbus.services;

var ApplicationsBlur = class ApplicationsBlur {
    constructor(connections, prefs) {
        this.connections = connections;
        this.prefs = prefs;
        this.paint_signals = new PaintSignals(connections);

        // stores every blurred window
        this.window_map = new Map();
        // stores every blur actor
        this.blur_actor_map = new Map();
    }

    enable() {
        this._log("blurring applications...");

        // export dbus service for preferences
        this.service = new ApplicationsService;
        this.service.export();

        // blur already existing windows
        this.update_all_windows();

        // blur every new window
        this.connections.connect(
            global.display,
            'window-created',
            (_meta_display, meta_window) => {
                this._log("window created");

                if (meta_window) {
                    let window_actor = meta_window.get_compositor_private();
                    this.track_new(window_actor, meta_window);
                }
            }
        );
    }

    /// Iterate through all existing windows and add blur as needed.
    update_all_windows() {
        // remove all previously blurred windows, in the case where the
        // whitelist was changed
        this.window_map.forEach(((_meta_window, pid) => {
            this.remove_blur(pid);
        }));

        for (
            let i = 0;
            i < global.workspace_manager.get_n_workspaces();
            ++i
        ) {
            let workspace = global.workspace_manager.get_workspace_by_index(i);
            let windows = workspace.list_windows();

            windows.forEach(meta_window => {
                let window_actor = meta_window.get_compositor_private();

                // disconnect previous signals
                this.connections.disconnect_all_for(window_actor);

                this.track_new(window_actor, meta_window);
            });
        }
    }

    /// Adds the needed signals to every new tracked window, and adds blur if
    /// needed.
    track_new(window_actor, meta_window) {
        let pid = ("" + Math.random()).slice(2, 16);

        window_actor['blur_provider_pid'] = pid;
        meta_window['blur_provider_pid'] = pid;

        // remove the blur when the window is destroyed
        this.connections.connect(window_actor, 'destroy', window_actor => {
            let pid = window_actor.blur_provider_pid;
            if (this.blur_actor_map.has(pid)) {
                this.remove_blur(pid);
            }
            this.window_map.delete(pid);
        });

        // update the blur when mutter-hint or wm-class is changed
        for (const prop of ['mutter-hints', 'wm-class']) {
            this.connections.connect(
                meta_window,
                `notify::${prop}`,
                _ => {
                    let pid = meta_window.blur_provider_pid;
                    this._log(`${prop} changed for pid ${pid}`);

                    let window_actor = meta_window.get_compositor_private();
                    this.check_blur(pid, window_actor, meta_window);
                }
            );
        }

        // update the offset constraints when the window size changes
        this.connections.connect(meta_window, 'size-changed', () => {
            if (this.blur_actor_map.has(pid)) {
                let offset = this.compute_offset(meta_window);
                let blur_actor = this.blur_actor_map.get(pid);
                let constraints = blur_actor.get_constraints();
                blur_actor.x = offset.x;
                blur_actor.y = offset.y;
                constraints[0].offset = offset.width;
                constraints[1].offset = offset.height;
            }
        });

        this.check_blur(pid, window_actor, meta_window);
    }

    /// Checks if the given actor needs to be blurred.
    ///
    /// In order to be blurred, a window either:
    /// - is whitelisted in the user preferences if not enable-all
    /// - is not blacklisted if enable-all
    /// - has a correct mutter hint, set to `blur-provider=sigma_value`
    check_blur(pid, window_actor, meta_window) {
        let mutter_hint = meta_window.get_mutter_hints();
        let window_wm_class = meta_window.get_wm_class();

        let enable_all = this.prefs.applications.ENABLE_ALL;
        let whitelist = this.prefs.applications.WHITELIST;
        let blacklist = this.prefs.applications.BLACKLIST;

        this._log(`checking blur for ${pid}`);

        // either the window is included in whitelist
        if (window_wm_class !== ""
            && ((enable_all && !blacklist.includes(window_wm_class))
                || (!enable_all && whitelist.includes(window_wm_class))
            )
        ) {
            this._log(`application ${pid} listed, blurring it`);

            // get blur effect parameters

            let brightness, sigma;

            if (this.prefs.applications.CUSTOMIZE) {
                brightness = this.prefs.applications.BRIGHTNESS;
                sigma = this.prefs.applications.SIGMA;
            } else {
                brightness = this.prefs.BRIGHTNESS;
                sigma = this.prefs.SIGMA;
            }

            this.update_blur(pid, window_actor, meta_window, brightness, sigma);
        }

        // or blur is asked by window itself
        else if (
            mutter_hint != null &&
            mutter_hint.includes("blur-provider")
        ) {
            this._log(`application ${pid} has hint ${mutter_hint}, parsing`);

            // get blur effect parameters
            let [brightness, sigma] = this.parse_xprop(mutter_hint);

            this.update_blur(pid, window_actor, meta_window, brightness, sigma);
        }

        // remove blur if the mutter hint is no longer valid, and the window
        // is not explicitly whitelisted or un-blacklisted
        else if (this.blur_actor_map.has(pid)) {
            this.remove_blur(pid);
        }
    }

    /// When given the xprop property, returns the brightness and sigma values
    /// matching. If one of the two values is invalid, or missing, then it uses
    /// default values.
    ///
    /// An xprop property is valid if it is in one of the following formats:
    ///
    ///     blur-provider=sigma:60,brightness:0.9
    ///     blur-provider=s:10,brightness:0.492
    ///     blur-provider=b:1.0,s:16
    ///
    /// Brightness is a floating-point between 0.0 and 1.0 included.
    /// Sigma is an integer between 0 and 999 included.
    ///
    /// If sigma is set to 0, then the blur is removed.
    /// Setting "default" instead of the two values will make the
    /// extension use its default value.
    ///
    /// Note that no space can be inserted.
    ///
    parse_xprop(property) {
        // set brightness and sigma to default values
        let brightness, sigma;
        if (this.prefs.applications.CUSTOMIZE) {
            brightness = this.prefs.applications.BRIGHTNESS;
            sigma = this.prefs.applications.SIGMA;
        } else {
            brightness = this.prefs.BRIGHTNESS;
            sigma = this.prefs.SIGMA;
        }

        // get the argument of the property
        let arg = property.match("blur-provider=(.*)");
        this._log(`argument = ${arg}`);

        // if argument is valid, parse it
        if (arg != null) {
            // verify if there is only one value: in this case, this is sigma
            let maybe_sigma = parseInt(arg[1]);

            if (
                !isNaN(maybe_sigma) &&
                maybe_sigma >= 0 &&
                maybe_sigma <= 999
            ) {
                sigma = maybe_sigma;
            } else {
                // perform pattern matching
                let res_b = arg[1].match("(brightness|b):(default|0?1?\.[0-9]*)");
                let res_s = arg[1].match("(sigma|s):(default|\\d{1,3})");

                // if values are valid and not default, change them to the xprop one
                if (
                    res_b != null && res_b[2] !== 'default'
                ) {
                    brightness = parseFloat(res_b[2]);
                }

                if (
                    res_s != null && res_s[2] !== 'default'
                ) {
                    sigma = parseInt(res_s[2]);
                }
            }
        }

        this._log(`brightness = ${brightness}, sigma = ${sigma}`);

        return [brightness, sigma];
    }

    /// Updates the blur on a window which needs to be blurred.
    update_blur(pid, window_actor, meta_window, brightness, sigma) {
        // the window is already blurred, update its blur effect
        if (this.blur_actor_map.has(pid)) {
            // window is already blurred, but sigma is null: remove the blur
            if (sigma === 0) {
                this.remove_blur(pid);
            }
            // window is already blurred and sigma is non-null: update it
            else {
                this.update_blur_effect(
                    this.blur_actor_map.get(pid),
                    brightness,
                    sigma
                );
            }
        }

        // the window is not blurred, and sigma is a non-null value: blur it
        else if (sigma !== 0) {
            // window is not blurred, blur it
            this.create_blur_effect(
                pid,
                window_actor,
                meta_window,
                brightness,
                sigma
            );
        }
    }

    /// Add the blur effect to the window.
    create_blur_effect(pid, window_actor, meta_window, brightness, sigma) {
        let blur_effect = new Shell.BlurEffect({
            sigma: sigma,
            brightness: brightness,
            mode: Shell.BlurMode.BACKGROUND
        });

        let blur_actor = this.create_blur_actor(
            meta_window,
            window_actor,
            blur_effect
        );

        // if hacks are selected, force to repaint the window
        if (this.prefs.HACKS_LEVEL >= 1) {
            this._log("applications hack level 1 or 2");

            this.paint_signals.disconnect_all();
            this.paint_signals.connect(blur_actor, blur_effect);
        } else {
            this.paint_signals.disconnect_all();
        }

        window_actor.insert_child_at_index(blur_actor, 0);

        // register the blur actor/effect
        blur_actor['blur_provider_pid'] = pid;
        this.blur_actor_map.set(pid, blur_actor);
        this.window_map.set(pid, meta_window);

        // hide the blur if window is invisible
        if (!window_actor.visible) {
            blur_actor.hide();
        }

        // hide the blur if window becomes invisible
        this.connections.connect(
            window_actor,
            'notify::visible',
            window_actor => {
                let pid = window_actor.blur_provider_pid;
                if (window_actor.visible) {
                    this.blur_actor_map.get(pid).show();
                } else {
                    this.blur_actor_map.get(pid).hide();
                }
            }
        );
    }

    // Compute the offset constraints for a blur actor relative to the size and
    // position of the target window
    compute_offset(meta_window) {
        let frame = meta_window.get_frame_rect();
        let buffer = meta_window.get_buffer_rect();
        return {
            x: frame.x - buffer.x,
            y: frame.y - buffer.y,
            width: frame.width - buffer.width,
            height: frame.height - buffer.height
        };
    }

    /// Returns a new already blurred widget, configured to follow the size and
    /// position of its target window.
    create_blur_actor(meta_window, window_actor, blur_effect) {
        // create the constraints in size and position to its target window
        let offset = this.compute_offset(meta_window);

        let constraint_width = new Clutter.BindConstraint({
            source: window_actor,
            coordinate: Clutter.BindCoordinate.WIDTH,
            offset: offset.width
        });
        let constraint_height = new Clutter.BindConstraint({
            source: window_actor,
            coordinate: Clutter.BindCoordinate.HEIGHT,
            offset: offset.height
        });

        // create the actor and add the constraints
        let blur_actor = new Clutter.Actor();
        blur_actor.add_constraint(constraint_width);
        blur_actor.add_constraint(constraint_height);

        // set position
        blur_actor.x = offset.x;
        blur_actor.y = offset.y;

        // add the effect
        blur_actor.add_effect_with_name('blur-effect', blur_effect);

        return blur_actor;
    }

    /// Updates the blur effect by overwriting its sigma and brightness values.
    update_blur_effect(blur_actor, brightness, sigma) {
        let effect = blur_actor.get_effect('blur-effect');
        effect.sigma = sigma;
        effect.brightness = brightness;
    }

    /// Removes the blur actor from the shell and unregister it.
    remove_blur(pid) {
        this._log(`removing blur for pid ${pid}`);

        // global.window_group is null when restarting the shell, causing an
        // innocent crash
        if (global.window_group == null)
            return;


        let meta_window = this.window_map.get(pid);
        // disconnect needed signals and untrack window
        if (meta_window) {
            this.window_map.delete(pid);

            // remove blur actor and untrack it
            let blur_actor = this.blur_actor_map.get(pid);
            if (blur_actor) {
                this.blur_actor_map.delete(pid);

                let window_actor = meta_window.get_compositor_private();
                if (window_actor)
                    window_actor.remove_child(blur_actor);
            }
        }
    }

    disable() {
        this._log("removing blur from applications...");

        this.service.unexport();

        this.blur_actor_map.forEach(((_blur_actor, pid) => {
            this.remove_blur(pid);
        }));

        this.connections.disconnect_all();
        this.paint_signals.disconnect_all();
    }

    /// Updates each blur effect to use new sigma value
    // FIXME set_sigma and set_brightness are called when the extension is
    // loaded and when sigma is changed, and do not respect the per-app
    // xprop behaviour
    set_sigma(s) {
        this.blur_actor_map.forEach((actor, _) => {
            actor.get_effect('blur-effect').set_sigma(s);
        });
    }

    /// Updates each blur effect to use new brightness value
    set_brightness(b) {
        this.blur_actor_map.forEach((actor, _) => {
            actor.get_effect('blur-effect').set_brightness(b);
        });
    }

    // not implemented for dynamic blur
    set_color(c) { }
    set_noise_amount(n) { }
    set_noise_lightness(l) { }

    _log(str) {
        if (this.prefs.DEBUG)
            log(`[Blur my Shell > applications] ${str}`);
    }
};
