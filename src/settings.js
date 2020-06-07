'use strict';

const Gio = imports.gi.Gio;
const Extension = imports.misc.extensionUtils.getCurrentExtension();

const SCHEMA_PATH = 'org.gnome.shell.extensions.blur-my-shell';

function get_local_gsettings(schema_path) {
    const GioSSS = Gio.SettingsSchemaSource;
    let schemaDir = Extension.dir.get_child('schemas');
    let schemaSource = GioSSS.get_default();

    if (schemaDir.query_exists(null)) {
        schemaSource = GioSSS.new_from_directory(
            schemaDir.get_path(),
            schemaSource,
            false);
    }

    let schemaObj = schemaSource.lookup(schema_path, true);
    if (!schemaObj) {
        throw new Error(
            `Schema ${schema_path} could not be found for extension ${Extension.metadata.uuid}`
        );
    }
    return new Gio.Settings({ settings_schema: schemaObj });
};

class Prefs {
    constructor() {
        var settings = this.settings = get_local_gsettings(SCHEMA_PATH);
        this.SIGMA = {
            key: 'sigma',
            get: function () { return settings.get_int(this.key); },
            set: function (v) { settings.set_int(this.key, v); },
            changed: function (cb) { return settings.connect('changed::' + this.key, cb); },
            disconnect: function () { return settings.disconnect.apply(settings, arguments); },
        };

        this.BRIGHTNESS = {
            key: 'brightness',
            get: function () { return settings.get_double(this.key); },
            set: function (v) { settings.set_double(this.key, v); },
            changed: function (cb) { return settings.connect('changed::' + this.key, cb); },
            disconnect: function () { return settings.disconnect.apply(settings, arguments); },
        };
    }
};