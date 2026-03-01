/* global imports, _ */
/* eslint camelcase: "off" */

const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Util = imports.misc.util;
const PopupMenu = imports.ui.popupMenu;
const UPowerGlib = imports.gi.UPowerGlib;
const Settings = imports.ui.settings;
const Calendar = require('./calendar');
const EventView = require('./eventView');
const Worldclocks = require("./worldclocks");
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const Main = imports.ui.main;

const Gettext = imports.gettext;
const UUID = "calendar@akenejie";
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

const _ = function(str) {
    return Gettext.dgettext(UUID, str);
};

const C_ = function(ctx, str) {
    return Gettext.dpgettext(UUID, ctx, str);
};

const DAY_FORMAT = CinnamonDesktop.WallClock.lctime_format(UUID, "%A");
const DATE_FORMAT_SHORT = CinnamonDesktop.WallClock.lctime_format(UUID, _("%B %-e, %Y"));
const DATE_FORMAT_FULL = CinnamonDesktop.WallClock.lctime_format(UUID, _("%A, %B %-e, %Y"));

class CinnamonCalendarApplet extends Applet.TextApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        try {
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.orientation = orientation;

            this._initContextMenu();
            this.menu.setCustomStyleClass('calendar-background');

            this.settings = new Settings.AppletSettings(this, "calendar@akenejie", this.instance_id);
            this.settings.bind("show-events", "show_events", this._onSettingsChanged);
            this.settings.bind("use-custom-format", "use_custom_format", this._onSettingsChanged);
            this.settings.bind("custom-format", "custom_format", this._onSettingsChanged);
            this.settings.bind("custom-tooltip-format", "custom_tooltip_format", this._onSettingsChanged);
            this.settings.bind("event-list-date-format", "event_list_date_format", this._onSettingsChanged);
            this.settings.bind("keyOpen", "keyOpen", this._setKeybinding);
            this._setKeybinding();

            this.desktop_settings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });

            this.clock = new CinnamonDesktop.WallClock();
            this.clock_notify_id = 0;
            this._menu_open_idle_id = 0;

            // Events
            this.events_manager = new EventView.EventsManager(this.settings, this.desktop_settings);
            this.events_manager.connect("events-manager-ready", this._events_manager_ready.bind(this));
            this.events_manager.connect("has-calendars-changed", this._has_calendars_changed.bind(this));

            let box = new St.BoxLayout(
                {
                    style_class: 'calendar-main-box',
                    vertical: false
                }
            );
            this.menu.addActor(box);

            this.event_list = this.events_manager.get_event_list();
            this.event_list.connect("launched-calendar", Lang.bind(this.menu, this.menu.toggle));

            // hack to allow event list scrollbar to be dragged.
            this.event_list.connect("start-pass-events", Lang.bind(this.menu, () => {
                this.menu.passEvents = true;
            }));
            this.event_list.connect("stop-pass-events", Lang.bind(this.menu, () => {
                this.menu.passEvents = false;
            }));

            box.add_actor(this.event_list.actor);

            let calbox = new St.BoxLayout(
                {
                    vertical: true
                }
            );

            this.go_home_button = new St.BoxLayout(
                {
                    style_class: "calendar-today-home-button",
                    x_align: Clutter.ActorAlign.CENTER,
                    reactive: true,
                    vertical: true
                }
            );

            this.go_home_button.connect("enter-event", Lang.bind(this, (actor, event) => {
                actor.add_style_pseudo_class("hover");
            }));

            this.go_home_button.connect("leave-event", Lang.bind(this, (actor, event) => {
                actor.remove_style_pseudo_class("hover");
            }));

            this.go_home_button.connect("button-press-event", Lang.bind(this, (actor, event) => {
                if (event.get_button() == Clutter.BUTTON_PRIMARY) {
                    return Clutter.EVENT_STOP;
                }
            }));

            this.go_home_button.connect("button-release-event", Lang.bind(this, (actor, event) => {
                if (event.get_button() == Clutter.BUTTON_PRIMARY) {
                    // button immediately becomes non-reactive, so leave-event will never fire.
                    actor.remove_style_pseudo_class("hover");
                    this._resetCalendar();
                    return Clutter.EVENT_STOP;
                }
            }));

            calbox.add_actor(this.go_home_button);

            // Calendar
            this._day = new St.Label(
                {
                    style_class: "calendar-today-day-label"
                }
            );
            this.go_home_button.add_actor(this._day);

            // Date
            this._date = new St.Label(
                {
                    style_class: "calendar-today-date-label"
                }
            );
            this.go_home_button.add_actor(this._date);

            this._calendar = new Calendar.Calendar(this.settings, this.events_manager);
            this._calendar.connect("selected-date-changed", Lang.bind(this, this._updateClockAndDate));
            calbox.add_actor(this._calendar.actor);

            box.add_actor(calbox);

            let item = new PopupMenu.PopupMenuItem(_("Date and Time Settings"));
            item.connect("activate", Lang.bind(this, this._onLaunchSettings));

            this._applet_context_menu.addMenuItem(item);

            this.menu.addMenuItem(item);

            /* FIXME: Add gobject properties to the WallClock class to allow easier access from
             * its clients, and possibly a separate signal to notify of updates to these properties
             * (though GObject "changed" would be sufficient.) */
            this.desktop_settings.connect("changed::clock-use-24h", Lang.bind(this, function(key) {
                this._onSettingsChanged();
            }));
            this.desktop_settings.connect("changed::clock-show-seconds", Lang.bind(this, function(key) {
                this._onSettingsChanged();
            }));

            // https://bugzilla.gnome.org/show_bug.cgi?id=655129
            this._upClient = new UPowerGlib.Client();
            try {
                this._upClient.connect('notify-resume', Lang.bind(this, this._updateClockAndDate));
            } catch (e) {
                this._upClient.connect('notify::resume', Lang.bind(this, this._updateClockAndDate));
            }

            this.settings.connect("changed::worldclocks", Lang.bind(this, this._onWorldclocksChanged));
            this.worldsettings = {
                clocks: this.settings.getValue('worldclocks')
            };

            this._worldclocks = new Worldclocks.Worldclocks(calbox, this);
            this._updateFormatString();
        }
        catch (e) {
            global.logError(e);
        }
    }

    _onWorldclocksChanged(setting_provider, oldval, newval) {
        this.worldsettings.clocks = newval;
        this._worldclocks.buildClocks(this.worldsettings);
        this._worldclocks.updateClocks();
    }

    _setKeybinding() {
        Main.keybindingManager.addHotKey("calendar-open-" + this.instance_id, this.keyOpen, Lang.bind(this, this._openMenu));
    }

    _clockNotify(obj, pspec, data) {
        this._updateClockAndDate();
    }

    on_applet_clicked(event) {
        this._openMenu();
    }
    
    _openMenu() {
        this.menu.toggle();
    }

    _onSettingsChanged() {
        this._updateFormatString();
        this._updateClockAndDate();
        this.event_list.actor.visible = this.events_manager.is_active();
        
        if (this.use_custom_format && typeof this.event_list.set_date_format_callback === 'function') {
            this.event_list.set_date_format_callback(this._formatDateString.bind(this), this.event_list_date_format);
        } else if (typeof this.event_list.set_date_format_callback === 'function') {
            this.event_list.set_date_format_callback(null, null);
        }
        
        this.events_manager.select_date(this._calendar.getSelectedDate(), true);
    }

    on_custom_format_button_pressed() {
        Util.spawnCommandLine("xdg-open https://cinnamon-spices.linuxmint.com/strftime.php");
    }

    _onLaunchSettings() {
        this.menu.close();
        Util.spawnCommandLine("cinnamon-settings calendar");
    }

    _formatDateString(gDateTime, formatStr) {
        if (!formatStr) return formatStr;

        let y = gDateTime.get_year();
        let m = gDateTime.get_month();
        let d = gDateTime.get_day_of_month();
        let w = gDateTime.get_day_of_week(); 
        let w0 = w === 7 ? 0 : w; 

        let holidayName = "";
        if (this._calendar && this._calendar.holiday) {
            if (typeof this._calendar.holiday.matchMonth === 'function') {
                let datesMap = this._calendar.holiday.matchMonth(y, m);
                if (datesMap && datesMap.has(`${m}/${d}`)) {
                    let hData = datesMap.get(`${m}/${d}`);
                    if (hData && hData.length > 0) {
                        holidayName = hData[0];
                    }
                }
            }
        }

        let isHoliday = (holidayName !== "");

        let weekdays = ['日', '月', '火', '水', '木', '金', '土'];

        return formatStr.replace(/%([-]?)([a-zA-Zｼﾕｲﾜﾉﾛ%])/g, (match, modifier, code) => {
            let nPad = modifier !== '-'; 
            let pad2 = (num) => nPad ? String(num).padStart(2, '0') : String(num);
            let pad3 = (num) => nPad ? String(num).padStart(3, '0') : String(num);

            switch (code) {
                case 'a': return weekdays[w0]; 
                case 'A': return weekdays[w0] + '曜日';
                case 'w': return String(w0);
                case 'd': return pad2(d);
                case 'e': return nPad ? String(d).padStart(2, ' ') : String(d);
                case 'b': return String(m) + '月';
                case 'B': return String(m) + '月';
                case 'm': return pad2(m);
                case 'y': return pad2(y % 100);
                case 'Y': return String(y);
                case 'H': return pad2(gDateTime.get_hour());
                case 'I': {
                    let h12 = gDateTime.get_hour() % 12; 
                    return pad2(h12 === 0 ? 12 : h12);
                }
                case 'l': {
                    let h12 = gDateTime.get_hour() % 12;
                    let s = String(h12 === 0 ? 12 : h12);
                    return nPad ? s.padStart(2, ' ') : s;
                }
                case 'n': return '\n';
                case 'p': return gDateTime.get_hour() < 12 ? 'AM' : 'PM';
                case 'M': return pad2(gDateTime.get_minute());
                case 'S': return pad2(gDateTime.get_second());
                case 'f': return String(gDateTime.get_microsecond()).padStart(6, '0');
                case 'z': {
                    let offset = gDateTime.get_utc_offset() / 1000000;
                    let sign = offset >= 0 ? '+' : '-';
                    offset = Math.abs(offset);
                    let oh = Math.floor(offset / 3600);
                    let om = Math.floor((offset % 3600) / 60);
                    return sign + String(oh).padStart(2, '0') + String(om).padStart(2, '0');
                }
                case 'Z': return gDateTime.get_timezone_abbreviation();
                case 'j': return pad3(gDateTime.get_day_of_year());
                case 'U': return pad2(gDateTime.format('%U')); 
                case 'W': return pad2(gDateTime.format('%W'));
                case 'c': return gDateTime.format('%c'); 
                case 'x': return gDateTime.format('%x'); 
                case 'X': return gDateTime.format('%X');
                case 'ｼ': return isHoliday ? holidayName : '';
                case 'ﾕ': return isHoliday ? '・' + holidayName : '';
                case 'ｲ': return isHoliday ? '祝' : '';
                case 'ﾜ': return isHoliday ? '・祝' : '';
                case 'ﾉ': return isHoliday ? '呪' : '';
                case 'ﾛ': return isHoliday ? '・呪' : '';
                case '%': return '%';
                default: 
                    // unsupported code, just return match or allow format fallback
                    return match; 
            }
        });
    }

    _updateFormatString() {
        let in_vertical_panel = (this.orientation === St.Side.LEFT || this.orientation === St.Side.RIGHT);
        let world_string = this.custom_format;
        let main_string = this.custom_format;

        if (this.use_custom_format) {
            // we will let the label generation fail silently and use a fallback there if needed,
            // or we could test format by using a temp date.
            // For now, assume it's valid if the user enters it.
        } else {
            let use_24h = this.desktop_settings.get_boolean("clock-use-24h");
            let show_seconds = this.desktop_settings.get_boolean("clock-show-seconds");

            if (use_24h) {
                main_string = show_seconds ? "%H%n%M%n%S" : "%H%n%M%";
                world_string = show_seconds ? "%H:%M:%S (%a)" : "%H:%M (%a)";
            } else {
                main_string = show_seconds ? "%l%n%M%n%S" : "%l%n%M%";
                world_string = show_seconds ? "%l:%M:%S (%a)" : "%l:%M (%a)";
            }
            if (!in_vertical_panel) main_string = null;
        }

        this.worldsettings.format = world_string;
        this.mainsettings_format = main_string; // save it to use dynamically

        // Strip our custom codes so WallClock can parse the format for tick frequency.
        // WallClock needs to see %S to know it must update every second.
        let strip_custom = (fmt) => fmt ? fmt.replace(/%[ｼｲﾄﾕﾜﾉﾛ]/g, '') : fmt;
        this.clock.set_format_string(strip_custom(main_string));

        this._worldclocks.buildClocks(this.worldsettings);
    }

    _events_manager_ready(em) {
        this.event_list.actor.visible = this.events_manager.is_active();
        this.events_manager.select_date(this._calendar.getSelectedDate(), true);
    }

    _has_calendars_changed(em) {
        this.event_list.actor.visible = this.events_manager.is_active();
    }

    _updateClockAndDate() {
        let now = new Date();
        let current_date = now.getDate();
        if (this._last_date !== current_date) {
            this._last_date = current_date;
            this._updateFormatString();
        }

        let localDateTime = GLib.DateTime.new_now_local();

        let label_string = "";
        let main_string = this.mainsettings_format;

        if (main_string) {
            label_string = this._formatDateString(localDateTime, main_string);
        } else { // fallback to clock if panel is horizontal and not custom
            label_string = this.clock.get_clock();
        }

        if (!label_string) {
            label_string = "~CLOCK FORMAT ERROR~ %l:%M %p".replace(/%l|%M|%p/g, (m) => localDateTime.format(m));
        }

        if (!this.use_custom_format) {
            label_string = label_string.capitalize();
        }

        this.go_home_button.reactive = !this._calendar.todaySelected();
        if (this._calendar.todaySelected()) {
            this.go_home_button.reactive = false;
            this.go_home_button.set_style_class_name("calendar-today-home-button");
        } else {
            this.go_home_button.reactive = true;
            this.go_home_button.set_style_class_name("calendar-today-home-button-enabled");
        }

        this.set_applet_label(label_string);

        let dateFormattedTooltip = this._formatDateString(localDateTime, DATE_FORMAT_FULL).capitalize();
        if (this.use_custom_format) {
            dateFormattedTooltip = this._formatDateString(localDateTime, this.custom_tooltip_format).capitalize();
            if (!dateFormattedTooltip) {
                global.logError("Calendar applet: bad tooltip time format string : " + this.custom_tooltip_format);
                dateFormattedTooltip = this._formatDateString(localDateTime, "~CLOCK FORMAT ERROR~ %l:%M %p");
            }
        }

        let dateFormattedShort = this._formatDateString(localDateTime, DATE_FORMAT_SHORT).capitalize();
        let dayFormatted = this._formatDateString(localDateTime, DAY_FORMAT).capitalize();

        this._day.set_text(dayFormatted);
        this._date.set_text(dateFormattedShort);
        this.set_applet_tooltip(dateFormattedTooltip);

        this.events_manager.select_date(this._calendar.getSelectedDate());

        this._worldclocks.updateClocks();
    }

    on_applet_added_to_panel() {
        this._onSettingsChanged();

        if (this.clock_notify_id === 0) {
            this.clock_notify_id = this.clock.connect("notify::clock", () => this._clockNotify());
        }

        /* Populates the calendar so our menu allocation is correct for animation */
        this.events_manager.start_events();
        this._resetCalendar();
    }

    on_applet_removed_from_panel() {
        Main.keybindingManager.removeHotKey("calendar-open-" + this.instance_id);
        if (this._menu_open_idle_id > 0) {
            Mainloop.source_remove(this._menu_open_idle_id);
            this._menu_open_idle_id = 0;
        }
        if (this.clock_notify_id > 0) {
            this.clock.disconnect(this.clock_notify_id);
            this.clock_notify_id = 0;
        }
    }

    _initContextMenu () {
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Whenever the menu is opened, select today.
        // Use idle_add to defer heavy calendar rebuilding until after the open animation starts,
        // preventing UI jank on click.
        this.menu.connect('open-state-changed', Lang.bind(this, function(menu, isOpen) {
            if (isOpen) {
                if (this._menu_open_idle_id > 0) {
                    Mainloop.source_remove(this._menu_open_idle_id);
                }
                this._menu_open_idle_id = Mainloop.idle_add(Lang.bind(this, function() {
                    this._menu_open_idle_id = 0;
                    this._resetCalendar();
                    this.events_manager.select_date(this._calendar.getSelectedDate(), true);
                    return GLib.SOURCE_REMOVE;
                }));
            }
        }));
    }

    _resetCalendar () {
        this._calendar.setDate(new Date(), true);
        this._worldclocks.updateClocks();
    }

    on_orientation_changed (orientation) {
        this.orientation = orientation;
        this.menu.setOrientation(orientation);
        this._onSettingsChanged();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonCalendarApplet(orientation, panel_height, instance_id);
}
