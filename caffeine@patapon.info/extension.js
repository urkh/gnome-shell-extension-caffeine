/* -*- mode: js2 - indent-tabs-mode: nil - js2-basic-offset: 4 -*- */
/* jshint multistr:true */
/* jshint esnext:true */
/* exported enable disable init */
/**
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 **/

'use strict';

const { Atk, Gtk, Gio, GObject, Shell, St, Meta, Clutter, GLib } = imports.gi;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const QuickSettings = imports.ui.quickSettings;
const QuickSettingsMenu = imports.ui.main.panel.statusArea.quickSettings;

const INHIBIT_APPS_KEY = 'inhibit-apps';
const SHOW_INDICATOR_KEY = 'show-indicator';
const SHOW_NOTIFICATIONS_KEY = 'show-notifications';
const SHOW_TIMER_KEY= 'show-timer';
const USER_ENABLED_KEY = 'user-enabled';
const RESTORE_KEY = 'restore-state';
const FULLSCREEN_KEY = 'enable-fullscreen';
const NIGHT_LIGHT_KEY = 'control-nightlight';
const TOGGLE_SHORTCUT = 'toggle-shortcut';
const TIMER_KEY = 'countdown-timer';
const TIMER_ENABLED_KEY = 'countdown-timer-enabled';

const Gettext = imports.gettext.domain('gnome-shell-extension-caffeine');
const _ = Gettext.gettext;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const ColorInterface = '<node> \
  <interface name="org.gnome.SettingsDaemon.Color"> \
    <property name="DisabledUntilTomorrow" type="b" access="readwrite"/>\
    <property name="NightLightActive" type="b" access="read"/>\
  </interface>\
  </node>';

const ColorProxy = Gio.DBusProxy.makeProxyWrapper(ColorInterface);

const DBusSessionManagerIface = '<node>\
  <interface name="org.gnome.SessionManager">\
    <method name="Inhibit">\
        <arg type="s" direction="in" />\
        <arg type="u" direction="in" />\
        <arg type="s" direction="in" />\
        <arg type="u" direction="in" />\
        <arg type="u" direction="out" />\
    </method>\
    <method name="Uninhibit">\
        <arg type="u" direction="in" />\
    </method>\
       <method name="GetInhibitors">\
           <arg type="ao" direction="out" />\
       </method>\
    <signal name="InhibitorAdded">\
        <arg type="o" direction="out" />\
    </signal>\
    <signal name="InhibitorRemoved">\
        <arg type="o" direction="out" />\
    </signal>\
  </interface>\
</node>';

const DBusSessionManagerProxy = Gio.DBusProxy.makeProxyWrapper(DBusSessionManagerIface);

const DBusSessionManagerInhibitorIface = '<node>\
  <interface name="org.gnome.SessionManager.Inhibitor">\
    <method name="GetAppId">\
        <arg type="s" direction="out" />\
    </method>\
  </interface>\
</node>';

const DBusSessionManagerInhibitorProxy = Gio.DBusProxy.makeProxyWrapper(DBusSessionManagerInhibitorIface);

const IndicatorName = 'Caffeine';
const TimerMenuName = 'Caffeine timers';
const DisabledIcon = 'my-caffeine-off-symbolic';
const EnabledIcon = 'my-caffeine-on-symbolic';
const TimerMenuIcon = 'stopwatch-symbolic';

const ControlNightLight = {
    NEVER: 0,
    ALWAYS: 1,
    FOR_APPS: 2,
};

const ShowIndicator = {
    ONLY_ACTIVE: 0,
    ALWAYS: 1,
    NEVER: 2,
};

//label: C_('Power profile', 'Performance'),
const TIMERS = [    
    {5:['5:00', 'caffeine-short-timer-symbolic']},
    {10:['10:00', 'caffeine-medium-timer-symbolic']},
    {30:['30:00', 'caffeine-long-timer-symbolic']},
    {0:[_('Infinite'), 'caffeine-infinite-timer-symbolic']},
];

let CaffeineIndicator;
/*
* ------- Load custom icon -------
* hack (for Wayland?) via https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/1997
* 
* For some reasons, I cannot use this instead:
*  'let iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())'
* see https://gjs.guide/extensions/upgrading/gnome-shell-40.html#custom-icon-theme
*  I get this error: "TypeError: Gtk.IconTheme.get_for_display is not a function"
*  This same line of code works on prefs.js... (Gnome 43)
*/
Gtk.IconTheme.get_default = function() {
    let theme = new Gtk.IconTheme();
    theme.set_custom_theme(St.Settings.get().gtk_icon_theme);
    return theme;
};

const FeatureToggle = GObject.registerClass(
class FeatureToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            label: IndicatorName,
            toggleMode: true,
        });
        
        this._settings = ExtensionUtils.getSettings();
                    
        // Icons
        this.finalTimerMenuIcon = TimerMenuIcon;
        if (!Gtk.IconTheme.get_default().has_icon(TimerMenuIcon)) {
            this.finalTimerMenuIcon = 
                Gio.icon_new_for_string(`${Me.path}/icons/${TimerMenuIcon}.svg`);
        }
        this._icon_actived = Gio.icon_new_for_string(`${Me.path}/icons/${EnabledIcon}.svg`);;
        this._icon_desactived = Gio.icon_new_for_string(`${Me.path}/icons/${DisabledIcon}.svg`);
        
        // Menu
        this.menu.setHeader(this.finalTimerMenuIcon, TimerMenuName, null);
        
        this._timerItems = new Map();
        this._itemsSection = new PopupMenu.PopupMenuSection();
        
        // Init Timers
        this._syncTimers();
        this._sync();
        this.menu.addMenuItem(this._itemsSection);        

        this._settings.bind(`${USER_ENABLED_KEY}`,
            this, 'checked',
            Gio.SettingsBindFlags.DEFAULT);
        
        // icon
        this._iconName();

        this._settings.connect(`changed::${USER_ENABLED_KEY}`, () => {
            this._iconName();
        });
        this._settings.connect(`changed::${TIMER_KEY}`, () => {
            this._sync();
        });
    }
       
    _syncTimers() {
        this._itemsSection.removeAll();
        this._timerItems.clear();

        for (const timer of TIMERS) {
            const key = Object.keys(timer);
            const label = timer[key][0];
            if (!label)
                continue;
            const icon = Gio.icon_new_for_string(`${Me.path}/icons/${timer[key][1]}.svg`);
            const item = new PopupMenu.PopupImageMenuItem(label, icon);
            item.connect('activate',() => (this._checkTimer(Number(key))));
            this._timerItems.set(Number(key), item);
            this._itemsSection.addMenuItem(item);
        }
        this.menuEnabled = TIMERS.length > 2;
    }
    
    _sync() {
        const activeTimerId = this._settings.get_int(TIMER_KEY);

        for (const [timerId, item] of this._timerItems) {            
            item.setOrnament(timerId === activeTimerId
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
    }
    
    _checkTimer(timerId) {
        this._settings.set_int(TIMER_KEY, timerId);
        this._settings.set_boolean(TIMER_ENABLED_KEY, true);        
    }

    _iconName() {
        switch (this._settings.get_boolean(USER_ENABLED_KEY)) {
        case true:
            this.gicon = this._icon_actived;
            break;
        case false:
            this.gicon = this._icon_desactived;
            break;
        }
    }    
});

const Caffeine = GObject.registerClass(
class Caffeine extends QuickSettings.SystemIndicator {
    _init() {
        super._init();

        this._indicator = this._addIndicator();

        this._settings = ExtensionUtils.getSettings();

        this._proxy = new ColorProxy(Gio.DBus.session, 'org.gnome.SettingsDaemon.Color', '/org/gnome/SettingsDaemon/Color', (proxy, error) => {
            if (error)
                log(error.message);
        });

        this._night_light = false;

        this._sessionManager = new DBusSessionManagerProxy(Gio.DBus.session,
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager');
        this._inhibitorAddedId = this._sessionManager.connectSignal('InhibitorAdded', this._inhibitorAdded.bind(this));
        this._inhibitorRemovedId = this._sessionManager.connectSignal('InhibitorRemoved', this._inhibitorRemoved.bind(this));

        // From auto-move-windows@gnome-shell-extensions.gcampax.github.com
        this._appSystem = Shell.AppSystem.get_default();

        this._appsChangedId =
            this._appSystem.connect('installed-changed',
                this._updateAppData.bind(this));

        // ("screen" in global) is false on 3.28, although global.screen exists
        if (typeof global.screen !== 'undefined') {
            this._screen = global.screen;
            this._display = this._screen.get_display();
        } else {
            this._screen = global.display;
            this._display = this._screen;
        }
 
        // Add indicator label for the timer
        this._timerLabel = new St.Label({
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerLabel.visible = false;
        this.add_child(this._timerLabel);

        // Icons
        this._icon_actived = Gio.icon_new_for_string(`${Me.path}/icons/${EnabledIcon}.svg`);;
        this._icon_desactived = Gio.icon_new_for_string(`${Me.path}/icons/${DisabledIcon}.svg`);
        this._indicator.gicon = this._icon_desactived;

        this._state = false;
        this._userState = false;
        // who has requested the inhibition
        this._last_app = '';
        this._last_cookie = '';
        this._apps = [];
        this._cookies = [];
        this._objects = [];
        
        // Init Timers
        this._timeOut = null;
        this._timePrint = null;
        this._timerEnable = false;

        // Init settings keys and restore user state
        this._settings.reset(USER_ENABLED_KEY);
        this._settings.reset(TIMER_ENABLED_KEY);
        this._settings.reset(TIMER_KEY);
        if (this._settings.get_boolean(USER_ENABLED_KEY) && this._settings.get_boolean(RESTORE_KEY)) {
            this.toggleState();
        } else {
            // reset user state
            this._settings.reset(USER_ENABLED_KEY);
        }

        // Show icon
        this._manageShowIndicator();

        // Enable caffeine when fullscreen app is running
        if (this._settings.get_boolean(FULLSCREEN_KEY)) {
            this._inFullscreenId = this._screen.connect('in-fullscreen-changed', this.toggleFullscreen.bind(this));
            this.toggleFullscreen();
        }

        this._appConfigs = [];
        this._appData = new Map();
        
        // Events
        this._settings.connect(`changed::${INHIBIT_APPS_KEY}`, this._updateAppConfigs.bind(this));
        this._settings.connect(`changed::${USER_ENABLED_KEY}`, this._updateUserState.bind(this));
        this._settings.connect(`changed::${TIMER_ENABLED_KEY}`, this._startTimer.bind(this));
        this._settings.connect(`changed::${SHOW_TIMER_KEY}`, this._showIndicatorLabel.bind(this));
        this._settings.connect(`changed::${SHOW_INDICATOR_KEY}`, () => {
            this._manageShowIndicator();
            this._showIndicatorLabel();
        });    
        
        this._updateAppConfigs();
        
        // QuickSettings
        this._caffeineToggle = new FeatureToggle();
        this.quickSettingsItems.push(this._caffeineToggle);
        
        // Change user state on icon scroll event
        this._indicator.reactive = true;
        this._indicator.connect('scroll-event',
            (actor, event) => this._handleScrollEvent(event));    
            
        this.connect('destroy', () => {
            this.quickSettingsItems.forEach(item => item.destroy());
        });

        QuickSettingsMenu._indicators.insert_child_at_index(this,0);
        QuickSettingsMenu._addItems(this.quickSettingsItems);
    }

    get inFullscreen() {
        let nbMonitors = this._screen.get_n_monitors();
        let inFullscreen = false;
        for (let i = 0; i < nbMonitors; i++) {
            if (this._screen.get_monitor_in_fullscreen(i)) {
                inFullscreen = true;
                break;
            }
        }
        return inFullscreen;
    }
    
    toggleFullscreen() {
        Mainloop.timeout_add_seconds(2, () => {
            if (this.inFullscreen && !this._apps.includes('fullscreen')) {
                this.addInhibit('fullscreen');
                this._manageNightLight('disabled');
            }
        });

        if (!this.inFullscreen && this._apps.includes('fullscreen')) {
            this.removeInhibit('fullscreen');
            this._manageNightLight('enabled');
        }
    }

    toggleState() {
        if (this._state) {
            this._removeTimer(false);
            this._apps.forEach(appId => this.removeInhibit(appId));
            this._manageNightLight('enabled');
        } else {     
            this.addInhibit('user');
            this._manageNightLight('disabled');
        }
    }

    addInhibit(appId) {
        this._sessionManager.InhibitRemote(appId,
            0, 'Inhibit by %s'.format(IndicatorName), 12,
            cookie => {
                this._last_cookie = cookie;
                this._last_app = appId;
            }
        );
    }

    removeInhibit(appId) {
        let index = this._apps.indexOf(appId);
        this._sessionManager.UninhibitRemote(this._cookies[index]);
    }
    
    _showIndicatorLabel() {
        if(this._settings.get_boolean(SHOW_TIMER_KEY) 
          && (this._settings.get_enum(SHOW_INDICATOR_KEY) !== ShowIndicator.NEVER)
          && this._timerEnable) {
            this._timerLabel.visible=true;
        } else {
            this._timerLabel.visible=false;
        }
    }

    _startTimer() {       
        if(this._settings.get_boolean(TIMER_ENABLED_KEY)) {        
            this._timerEnable = true;
            
            // Reset Timer
            this._removeTimer(true);
            
            // Enable Caffeine
            this._settings.set_boolean(USER_ENABLED_KEY, true);
            
            // Get duration 
            let timerDelay = (this._settings.get_int(TIMER_KEY) * 60);

            // Execute Timer only if duration isn't set on infinite time
            if(timerDelay !== 0) {         
                let secondLeft = timerDelay;
                this._showIndicatorLabel();
                this._printTimer(secondLeft);
                this._timePrint = GLib.timeout_add(GLib.PRIORITY_DEFAULT, (1000), () => {
                    secondLeft -= 1;
                    this._printTimer(secondLeft);
                    return GLib.SOURCE_CONTINUE;
                });
                
                this._timeOut = GLib.timeout_add(GLib.PRIORITY_DEFAULT, (timerDelay * 1000), () => {    
                    // Disable Caffeine when timer ended
                    this._removeTimer(false);
                    this._settings.set_boolean(USER_ENABLED_KEY, false);
                    return GLib.SOURCE_REMOVE;
                });
            }  
        }
    }
    
    _printTimer(second) {
        const min = Math.floor(second / 60);	                  
        const minS = Math.floor(second % 60).toLocaleString('en-US', {
            minimumIntegerDigits: 2,
            useGrouping: false
        });
        // Print Timer in system Indicator and Toggle menu subLabel
        this._updateLabelTimer(min + ':' + minS);
    }
    
    _removeTimer(reset) {
        if(!reset) {
            // Set duration back to 0
            this._settings.set_int(TIMER_KEY, 0);
            // End timer
            this._timerEnable = false;
        }
        this._settings.set_boolean(TIMER_ENABLED_KEY, false); 
        this._updateLabelTimer(null);
        
        // Remove timer
        if((this._timeOut !== null) || (this._timePrint !== null)) {
            GLib.Source.remove(this._timeOut);
            GLib.Source.remove(this._timePrint);
            this._timeOut=null;
            this._timePrint=null;
        }      
    }
    
    _updateLabelTimer(text) {
        this._timerLabel.text = text;
        this._caffeineToggle.menu.setHeader(this._caffeineToggle.finalTimerMenuIcon, TimerMenuName, text);        
    }
    
    _handleScrollEvent(event) {
        switch(event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                if(!this._state) {
                    // User state on - UP
                    this._settings.set_boolean(USER_ENABLED_KEY, true);
                    // Force notification here if disable in prefs
                    if (!this._settings.get_boolean(SHOW_NOTIFICATIONS_KEY))
                        this._sendOSDNotification(true);    
                }
                break;
            case Clutter.ScrollDirection.DOWN:
                if(this._state) {
                    // Stop timer
                    this._removeTimer(false);
                    // User state off - DOWN
                    this._settings.set_boolean(USER_ENABLED_KEY, false);
                    // Force notification here if disable in prefs
                    if (!this._settings.get_boolean(SHOW_NOTIFICATIONS_KEY))
                        this._sendOSDNotification(false);
                }
                break;
        }
    }

    _inhibitorAdded(proxy, sender, [object]) {
        this._sessionManager.GetInhibitorsRemote(([inhibitors]) => {
            for (let i of inhibitors) {
                let inhibitor = new DBusSessionManagerInhibitorProxy(Gio.DBus.session,
                    'org.gnome.SessionManager',
                    i);
                inhibitor.GetAppIdRemote(appId => {
                    appId = String(appId);
                    if (appId !== '' && appId === this._last_app) {
                        if (this._last_app === 'user')
                            this._saveUserState(true);
                        this._apps.push(this._last_app);
                        this._cookies.push(this._last_cookie);
                        this._objects.push(object);
                        this._last_app = '';
                        this._last_cookie = '';
                        if (this._state === false) {
                            this._state = true;
                            // Indicator icon
                            this._manageShowIndicator();
                            this._indicator.gicon = this._icon_actived;
                            // Shell OSD notifications
                            if (this._settings.get_boolean(SHOW_NOTIFICATIONS_KEY) && !this.inFullscreen)
                                this._sendOSDNotification(true);
                        }
                    }
                });
            }
        });
    }

    _inhibitorRemoved(proxy, sender, [object]) {
        let index = this._objects.indexOf(object);
        if (index !== -1) {
            if (this._apps[index] === 'user')
                this._saveUserState(false);
            // Remove app from list
            this._apps.splice(index, 1);
            this._cookies.splice(index, 1);
            this._objects.splice(index, 1);
            if (this._apps.length === 0) {
                this._state = false;
                // Indicator icon
                this._manageShowIndicator();
                this._indicator.gicon = this._icon_desactived;
                // Shell OSD notifications
                if (this._settings.get_boolean(SHOW_NOTIFICATIONS_KEY))
                    this._sendOSDNotification(false);
            }
        }
    }
    
    _manageShowIndicator() {
        if (this._state) {
            if (this._settings.get_enum(SHOW_INDICATOR_KEY) === ShowIndicator.NEVER) {
                this._indicator.visible = false;
            } else {
                this._indicator.visible = true;
            }
        } else {        
            if (this._settings.get_enum(SHOW_INDICATOR_KEY) === ShowIndicator.ALWAYS) {
                this._indicator.visible = true;
            } else {
                this._indicator.visible = false;
            }
        }
    }

    _manageNightLight(state) {
        const controlNl = this._settings.get_enum(NIGHT_LIGHT_KEY) === ControlNightLight.ALWAYS;
        if (state === 'enabled') {
            if (controlNl && this._proxy.NightLightActive) {
                this._proxy.DisabledUntilTomorrow = false;
                this._night_light = true;
            } else {
                this._night_light = false;
            }
        }
        if (state === 'disabled') {
            if (controlNl && this._proxy.NightLightActive) {
                this._proxy.DisabledUntilTomorrow = true;
                this._night_light = true;
            } else {
                this._night_light = false;
            }
        }
    }
    
    _sendOSDNotification(state) {
        if (state) {
            Main.osdWindowManager.show(-1, this._icon_actived,
                _('Auto suspend and screensaver disabled'), null, null);
        }
        else {
            Main.osdWindowManager.show(-1, this._icon_desactived, 
                _('Auto suspend and screensaver enabled'), null, null);
        }
    }

    // DEPRECATED
    _sendNotification(state) {
        const controllingNl = this._settings.get_enum(NIGHT_LIGHT_KEY) !== ControlNightLight.NEVER;
        if (state === 'enabled') {
            if (controllingNl && this._night_light && this._proxy.DisabledUntilTomorrow)
                Main.notify(_('Auto suspend and screensaver disabled. Night Light paused.'));
            else
                Main.notify(_('Auto suspend and screensaver disabled'));
        }
        if (state === 'disabled') {
            if (controllingNl && this._night_light && !this._proxy.DisabledUntilTomorrow)
                Main.notify(_('Auto suspend and screensaver enabled. Night Light resumed.'));
            else
                Main.notify(_('Auto suspend and screensaver enabled'));
        }
    }

    _updateAppConfigs() {
        this._appConfigs.length = 0;
        this._settings.get_strv(INHIBIT_APPS_KEY).forEach(appId => {
            this._appConfigs.push(appId);
        });
        this._updateAppData();
    }
    
    _updateUserState() {
        if (this._settings.get_boolean(USER_ENABLED_KEY) !== this._userState) {
            this._userState = !this._userState;
            this.toggleState();
        }
    }

    _saveUserState(state) {
        this._userState = state;
        this._settings.set_boolean(USER_ENABLED_KEY, state);
    }

    _updateAppData() {
        let ids = this._appConfigs.slice();
        let removedApps = [...this._appData.keys()]
            .filter(a => !ids.includes(a.id));
        removedApps.forEach(app => {
            app.disconnect(this._appData.get(app).windowsChangedId);
            this._appData.delete(app);
        });
        let addedApps = ids
            .map(id => this._appSystem.lookup_app(id))
            .filter(app => app && !this._appData.has(app));
        addedApps.forEach(app => {
            let data = {
                windowsChangedId: app.connect('windows-changed',
                    this._appWindowsChanged.bind(this)),
            };
            this._appData.set(app, data);
        });
    }

    _appWindowsChanged(app) {
        let appId = app.get_id();
        let appState = app.get_state();
        if (appState !== Shell.AppState.STOPPED) {
            this.addInhibit(appId);
            if (this._settings.get_enum(NIGHT_LIGHT_KEY) > ControlNightLight.NEVER && this._proxy.NightLightActive) {
                this._proxy.DisabledUntilTomorrow = true;
                this._night_light = true;
            } else {
                this._night_light = false;
            }
        } else {
            this.removeInhibit(appId);
            if (this._settings.get_enum(NIGHT_LIGHT_KEY) > ControlNightLight.NEVER && this._proxy.NightLightActive) {
                this._proxy.DisabledUntilTomorrow = false;
                this._night_light = true;
            } else {
                this._night_light = false;
            }
        }
    }

    destroy() {
        // remove all inhibitors
        this._apps.forEach(appId => this.removeInhibit(appId));
        // disconnect from signals
        if (this._settings.get_boolean(FULLSCREEN_KEY))
            this._screen.disconnect(this._inFullscreenId);
        if (this._inhibitorAddedId) {
            this._sessionManager.disconnectSignal(this._inhibitorAddedId);
            this._inhibitorAddedId = 0;
        }
        if (this._inhibitorRemovedId) {
            this._sessionManager.disconnectSignal(this._inhibitorRemovedId);
            this._inhibitorRemovedId = 0;
        }
        if (this._windowCreatedId) {
            this._display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._windowDestroyedId) {
            global.window_manager.disconnect(this._windowDestroyedId);
            this._windowDestroyedId = 0;
        }
        if (this._appsChangedId) {
            this._appSystem.disconnect(this._appsChangedId);
            this._appsChangedId = 0;
        }
        if (this._timeOut) {
            GLib.Source.remove(this._timeOut);
            this._timeOut = null;
        }
        if (this._timePrint) {
            GLib.Source.remove(this._timePrint);
            this._timePrint = null;
        }
        this._appConfigs.length = 0;
        this._updateAppData();
        super.destroy();
    }
});

/**
 * Steps to run on initialization of the extension
 */
function init() {
    ExtensionUtils.initTranslations();
}

/**
 * Steps to run when the extension is enabled
 */
function enable() {
    // Migrate old nightlight settings
    const _settings = ExtensionUtils.getSettings();
    const controlNightLight = _settings.get_value('control-nightlight');
    const controlNightLightForApp = _settings.get_value('control-nightlight-for-app');
    if (controlNightLight.unpack() === true) {
        let nightlightControl = ControlNightLight.ALWAYS;
        if (controlNightLightForApp.unpack() === true)
            nightlightControl = ControlNightLight.FOR_APPS;
        _settings.set_enum('nightlight-control', nightlightControl);
    }
    // remove deprecated settings
    _settings.reset('control-nightlight');
    _settings.reset('control-nightlight-for-app');

    CaffeineIndicator = new Caffeine();

    // Register shortcut
    Main.wm.addKeybinding(TOGGLE_SHORTCUT, _settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.ALL, () => {
        CaffeineIndicator.toggleState();
    });
}

/**
 * Steps to run when the extension is disabled
 */
function disable() {
    CaffeineIndicator.destroy();
    CaffeineIndicator = null;

    // Unregister shortcut
    Main.wm.removeKeybinding(TOGGLE_SHORTCUT);
}




