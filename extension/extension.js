import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

const UUID = 'dynamic-island-plus-v2@local';
const COLLAPSED_H = 38;
const IDLE_W = 112;
const CONTEXT_W = 300;
const EXPANDED_W = 510;
const EXPANDED_H = 236;
const TOP_LIMIT = 190;
const SNAP_PX = 130;
const DRAG_THRESHOLD = 7;

function unpack(v) {
    if (v === null || v === undefined)
        return v;
    if (typeof v.deepUnpack === 'function')
        return v.deepUnpack();
    if (typeof v.recursiveUnpack === 'function')
        return v.recursiveUnpack();
    return v;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function fmtSeconds(seconds) {
    seconds = Number(seconds) || 0;
    if (seconds <= 0)
        return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function safeText(s, fallback = '') {
    if (s === null || s === undefined)
        return fallback;
    return String(s).replace(/[\r\n\t]+/g, ' ').trim();
}

export default class DynamicIslandPlusExtension extends Extension {
    enable() {
        this._timers = [];
        this._signals = [];
        this._dbusSubs = [];
        this._players = new Map();
        this._notifications = [];
        this._agents = [];
        this._activePlayer = null;
        this._mediaState = {
            hasPlayer: false,
            playing: false,
            title: 'No media',
            artist: '',
            bus: null,
        };
        this._transient = null;
        this._transientTimeout = 0;
        this._expanded = false;
        this._activePage = 'media';
        this._lastAgentJson = '';
        this._dragCandidate = false;
        this._dragging = false;
        this._leaveTimeout = 0;
        this._mascotFrame = 0;
        this._mascotState = 'idle';
        this._mascotAgentId = '';
        this._mascotContextKey = '';
        this._lastNetworkOnline = null;
        this._lastBatteryCharging = null;
        this._position = this._loadPosition();

        this._runtimeDir = GLib.build_filenamev([
            GLib.get_user_runtime_dir() || GLib.get_tmp_dir(),
            'dynamic-island-plus-v2',
        ]);
        try { GLib.mkdir_with_parents(this._runtimeDir, 0o700); } catch (_) {}
        this._statePath = GLib.build_filenamev([this._runtimeDir, 'state.json']);
        this._responsesDir = GLib.build_filenamev([this._runtimeDir, 'responses']);
        try { GLib.mkdir_with_parents(this._responsesDir, 0o700); } catch (_) {}

        this._buildUi();
        this._initMascotAnimation();
        this._initMedia();
        this._initSystem();
        this._initBattery();
        this._initBluetooth();
        this._initNotifications();
        this._initOsdMirror();
        this._initAgentPolling();
        this._initDesktopFocus();
        this._positionIsland();

        this._signals.push([
            Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', () => this._positionIsland()),
        ]);

        this._stageEventId = global.stage.connect('captured-event', (_stage, event) => this._onStageEvent(event));
        this._signals.push([global.stage, this._stageEventId]);

        this._updateClock();
        this._refreshCollapsed();
    }

    disable() {
        if (this._transientTimeout) {
            try { GLib.source_remove(this._transientTimeout); } catch (_) {}
            this._transientTimeout = 0;
        }
        if (this._leaveTimeout) {
            try { GLib.source_remove(this._leaveTimeout); } catch (_) {}
            this._leaveTimeout = 0;
        }
        for (const id of this._timers) {
            try { GLib.source_remove(id); } catch (_) {}
        }
        this._timers = [];

        for (const [obj, id] of this._signals) {
            try { obj.disconnect(id); } catch (_) {}
        }
        this._signals = [];

        for (const id of this._dbusSubs) {
            try { Gio.DBus.session.signal_unsubscribe(id); } catch (_) {}
            try { Gio.DBus.system.signal_unsubscribe(id); } catch (_) {}
        }
        this._dbusSubs = [];

        for (const p of this._players.values()) {
            try {
                if (p.changedId)
                    p.proxy.disconnect(p.changedId);
            } catch (_) {}
        }
        this._players.clear();

        if (this._originalOsdShow && Main.osdWindowManager) {
            Main.osdWindowManager.show = this._originalOsdShow;
            this._originalOsdShow = null;
        }

        if (this._island) {
            try { Main.layoutManager.removeChrome(this._island); } catch (_) {}
            this._island.destroy();
            this._island = null;
        }

        this._batteryProxy = null;
        this._networkMonitor = null;
        this._players = null;
        this._notifications = null;
        this._agents = null;
    }

    _buildUi() {
        this._island = new St.Widget({
            style_class: 'dip-island',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: IDLE_W,
            height: COLLAPSED_H,
        });
        this._island.set_pivot_point(0.5, 0);

        try {
            if (Shell.BlurEffect) {
                this._blur = new Shell.BlurEffect({
                    brightness: 0.58,
                    sigma: 24,
                    mode: Shell.BlurMode.BACKGROUND,
                });
                this._island.add_effect(this._blur);
            }
        } catch (_) {
            this._blur = null;
        }

        this._root = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._island.add_child(this._root);

        this._collapsed = new St.BoxLayout({
            style_class: 'dip-collapsed',
            vertical: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._collapsedIcon = new St.Icon({
            icon_name: 'preferences-system-symbolic',
            style_class: 'dip-mini-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._collapsedMascot = this._makeMascotActor('idle', 'dip-mascot-mini');
        this._collapsedMascot.visible = false;
        this._collapsedMascotFace = this._collapsedMascot._dipFaceLabel;
        this._collapsedLabel = new St.Label({
            text: '',
            style_class: 'dip-collapsed-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._collapsedLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._collapsedValue = new St.Label({
            text: '',
            style_class: 'dip-collapsed-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._collapsed.add_child(this._collapsedIcon);
        this._collapsed.add_child(this._collapsedMascot);
        this._collapsed.add_child(this._collapsedLabel);
        this._collapsed.add_child(this._collapsedValue);
        this._root.add_child(this._collapsed);

        this._expandedBox = new St.BoxLayout({
            style_class: 'dip-expanded',
            vertical: true,
            visible: false,
            opacity: 0,
            x_expand: true,
            y_expand: true,
        });

        const top = new St.BoxLayout({style_class: 'dip-top-row', vertical: false, x_expand: true});
        this._title = new St.Label({
            text: 'Dynamic Island Plus',
            style_class: 'dip-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dragHint = new St.Label({
            text: '⋮⋮',
            style_class: 'dip-drag-hint',
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(this._title);
        top.add_child(this._dragHint);
        this._expandedBox.add_child(top);

        this._tabs = new St.BoxLayout({style_class: 'dip-tabs', vertical: false, x_expand: true});
        for (const [key, label, icon] of [
            ['media', 'Media', 'audio-x-generic-symbolic'],
            ['agents', 'Agents', 'applications-engineering-symbolic'],
            ['notifications', 'Alerts', 'preferences-system-notifications-symbolic'],
            ['system', 'System', 'computer-symbolic'],
        ]) {
            const b = new St.Button({
                style_class: 'dip-tab',
                label,
                x_expand: true,
                can_focus: true,
            });
            b.connect('clicked', () => this._switchPage(key));
            this._tabs.add_child(b);
            this[`_tab_${key}`] = b;
        }
        this._expandedBox.add_child(this._tabs);

        this._pages = new St.Widget({
            style_class: 'dip-pages',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._buildMediaPage();
        this._buildAgentsPage();
        this._buildNotificationsPage();
        this._buildSystemPage();
        this._pages.add_child(this._mediaPage);
        this._pages.add_child(this._agentsPage);
        this._pages.add_child(this._notifPage);
        this._pages.add_child(this._systemPage);
        this._expandedBox.add_child(this._pages);
        this._root.add_child(this._expandedBox);

        this._island.connect('enter-event', () => {
            if (!this._dragging)
                this._expand();
            return Clutter.EVENT_PROPAGATE;
        });
        this._island.connect('leave-event', () => {
            this._scheduleCollapse();
            return Clutter.EVENT_PROPAGATE;
        });
        this._island.connect('scroll-event', (_a, event) => {
            if (!this._expanded)
                return Clutter.EVENT_PROPAGATE;
            const order = ['media', 'agents', 'notifications', 'system'];
            let i = order.indexOf(this._activePage);
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.DOWN)
                i = (i + 1) % order.length;
            else if (dir === Clutter.ScrollDirection.UP)
                i = (i + order.length - 1) % order.length;
            else
                return Clutter.EVENT_PROPAGATE;
            this._switchPage(order[i]);
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.addTopChrome(this._island, {
            trackFullscreen: true,
            affectsStruts: false,
        });
        this._switchPage('media');
    }

    _buildMediaPage() {
        this._mediaPage = new St.BoxLayout({style_class: 'dip-page', vertical: true, x_expand: true, y_expand: true});
        const header = new St.BoxLayout({vertical: false, x_expand: true});
        this._mediaIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'dip-large-icon'});
        const textBox = new St.BoxLayout({vertical: true, x_expand: true});
        this._mediaTitle = new St.Label({text: 'No media active', style_class: 'dip-page-title', x_expand: true});
        this._mediaArtist = new St.Label({text: 'Start playback in Spotify, Firefox, Chrome or another MPRIS player', style_class: 'dip-subtitle', x_expand: true});
        this._mediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._mediaArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._mediaTitle);
        textBox.add_child(this._mediaArtist);
        header.add_child(this._mediaIcon);
        header.add_child(textBox);
        this._mediaPage.add_child(header);

        const controls = new St.BoxLayout({style_class: 'dip-media-controls', vertical: false, x_align: Clutter.ActorAlign.CENTER});
        const prev = this._iconButton('media-skip-backward-symbolic', () => this._mprisCall('Previous'));
        this._playButton = this._iconButton('media-playback-start-symbolic', () => this._mprisCall('PlayPause'));
        const next = this._iconButton('media-skip-forward-symbolic', () => this._mprisCall('Next'));
        controls.add_child(prev);
        controls.add_child(this._playButton);
        controls.add_child(next);
        this._mediaPage.add_child(controls);
    }

    _buildAgentsPage() {
        this._agentsPage = new St.BoxLayout({style_class: 'dip-page dip-agent-page', vertical: true, x_expand: true, y_expand: true});
        const mascotHead = new St.BoxLayout({style_class: 'dip-agent-mascot-head', vertical: false, x_expand: true});
        this._agentPageMascot = this._makeMascotActor('idle', 'dip-mascot-page');
        this._agentPageMascotFace = this._agentPageMascot._dipFaceLabel;
        this._agentsSummary = new St.Label({text: 'No AI agents connected', style_class: 'dip-page-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        mascotHead.add_child(this._agentPageMascot);
        mascotHead.add_child(this._agentsSummary);
        this._agentsPage.add_child(mascotHead);
        this._agentsList = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true, style_class: 'dip-agent-list'});
        this._agentsPage.add_child(this._agentsList);
    }

    _buildNotificationsPage() {
        this._notifPage = new St.BoxLayout({style_class: 'dip-page', vertical: true, x_expand: true, y_expand: true});
        const h = new St.Label({text: 'Recent notifications', style_class: 'dip-page-title'});
        this._notifPage.add_child(h);
        this._notifList = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._notifPage.add_child(this._notifList);
        this._rebuildNotifications();
    }

    _buildSystemPage() {
        this._systemPage = new St.BoxLayout({style_class: 'dip-page', vertical: true, x_expand: true, y_expand: true});
        const grid = new St.BoxLayout({vertical: true, x_expand: true});
        for (const [key, label, icon] of [
            ['network', 'Network', 'network-wireless-signal-excellent-symbolic'],
            ['cpu', 'CPU', 'cpu-symbolic'],
            ['ram', 'Memory', 'drive-harddisk-symbolic'],
            ['battery', 'Battery', 'battery-good-symbolic'],
            ['bluetooth', 'Bluetooth', 'bluetooth-active-symbolic'],
        ]) {
            const row = new St.BoxLayout({style_class: 'dip-status-row', vertical: false, x_expand: true});
            row.add_child(new St.Icon({icon_name: icon, style_class: 'dip-status-icon'}));
            row.add_child(new St.Label({text: label, style_class: 'dip-status-label', x_expand: true}));
            const value = new St.Label({text: '—', style_class: 'dip-status-value'});
            row.add_child(value);
            grid.add_child(row);
            this[`_status_${key}`] = value;
        }
        this._systemPage.add_child(grid);
        this._clockDetail = new St.Label({text: '', style_class: 'dip-clock-detail', x_align: Clutter.ActorAlign.CENTER});
        this._systemPage.add_child(this._clockDetail);
    }

    _iconButton(icon, cb) {
        const b = new St.Button({style_class: 'dip-icon-button', can_focus: true});
        b.set_child(new St.Icon({icon_name: icon, style_class: 'dip-control-icon'}));
        b.connect('clicked', cb);
        return b;
    }

    _switchPage(page) {
        this._activePage = page;
        for (const p of ['media', 'agents', 'notifications', 'system']) {
            this[`_${p === 'notifications' ? 'notif' : p}Page`].visible = p === page;
            const b = this[`_tab_${p}`];
            if (b) {
                if (p === page) b.add_style_pseudo_class('checked');
                else b.remove_style_pseudo_class('checked');
            }
        }
    }

    _expand() {
        if (this._expanded || this._dragging)
            return;
        if (this._leaveTimeout) {
            try { GLib.source_remove(this._leaveTimeout); } catch (_) {}
            this._leaveTimeout = 0;
        }
        this._expanded = true;
        this._collapsed.visible = false;
        this._expandedBox.visible = true;
        this._expandedBox.opacity = 0;
        this._island.add_style_class_name('expanded');
        const m = Main.layoutManager.primaryMonitor;
        const x = clamp(this._island.x + (this._island.width - EXPANDED_W) / 2, m.x, m.x + m.width - EXPANDED_W);
        this._island.ease({
            width: EXPANDED_W,
            height: EXPANDED_H,
            x,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._expandedBox.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _scheduleCollapse() {
        if (this._leaveTimeout) {
            try { GLib.source_remove(this._leaveTimeout); } catch (_) {}
        }
        this._leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._leaveTimeout = 0;
            if (!this._expanded || this._dragging)
                return GLib.SOURCE_REMOVE;
            let inside = false;
            try {
                const [px, py] = global.get_pointer();
                const [x, y] = this._island.get_transformed_position();
                const [w, h] = this._island.get_transformed_size();
                inside = px >= x && px <= x + w && py >= y && py <= y + h;
            } catch (_) {}
            if (!inside)
                this._collapse();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._leaveTimeout);
    }

    _collapse() {
        if (!this._expanded)
            return;
        this._expanded = false;
        const w = this._collapsedWidth();
        const m = Main.layoutManager.primaryMonitor;
        const center = this._island.x + this._island.width / 2;
        const x = clamp(center - w / 2, m.x, m.x + m.width - w);
        this._expandedBox.ease({opacity: 0, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._island.ease({
            width: w,
            height: COLLAPSED_H,
            x,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._island) return;
                this._expandedBox.visible = false;
                this._collapsed.visible = true;
                this._island.remove_style_class_name('expanded');
                this._refreshCollapsed();
            },
        });
    }

    _mascotStateForAgent(agent) {
        if (!agent)
            return 'idle';
        if (agent.pending)
            return agent.pending.kind === 'question' ? 'question' : 'permission';

        const status = safeText(agent.status, '').toLowerCase();
        const summary = safeText(agent.summary, '').toLowerCase();
        if (status.includes('error') || status.includes('fail') || summary.includes('error') || summary.includes('failed'))
            return 'error';
        if (status === 'done' || status === 'ended' || status.includes('finish') || summary.includes('completed'))
            return 'success';
        if (status.includes('interrupt'))
            return 'error';
        if (status.includes('wait'))
            return 'waiting';
        if (status.includes('think'))
            return 'thinking';
        return 'working';
    }

    _mascotFaces(state) {
        switch (state) {
        case 'thinking': return ['•_•', '•⌄•', '•_•', '–_–'];
        case 'working': return ['•⌄•', '•ᴗ•', '•⌄•', '–⌄–'];
        case 'permission': return ['◉△◉', '◉_◉', '◉△◉', '–△–'];
        case 'question': return ['◉?◉', '•?•', '◉?◉', '–?–'];
        case 'waiting': return ['◉_◉', '•_•', '◉_◉', '–_–'];
        case 'success': return ['^ᴗ^', '^‿^', '^ᴗ^', '–ᴗ–'];
        case 'error': return ['•︵•', '◉︵◉', '•︵•', '–︵–'];
        case 'music': return ['♫ᴗ♫', '♪ᴗ♪', '♫⌄♫', '–ᴗ–'];
        case 'paused': return ['•‿•', '•_•', '•‿•', '–_–'];
        case 'volume': return ['•O•', '•o•', '•O•', '–o–'];
        case 'muted': return ['•×•', '×_×', '•×•', '–×–'];
        case 'brightness': return ['◉ᴗ◉', '●ᴗ●', '◉⌄◉', '–ᴗ–'];
        case 'battery-low': return ['•︵•', '◉︵◉', '•︵•', '–︵–'];
        case 'charging': return ['ϟᴗϟ', '•ᴗ•', 'ϟ⌄ϟ', '–ᴗ–'];
        case 'bluetooth': return ['•⌄•', '◉ᴗ◉', '•⌄•', '–ᴗ–'];
        case 'notification': return ['◉!◉', '•!•', '◉!◉', '–!–'];
        case 'network': return ['•⌄•', '•ᴗ•', '•⌄•', '–ᴗ–'];
        case 'offline': return ['•︵•', '×_×', '•︵•', '–_–'];
        default: return ['•ᴗ•', '•ᴗ•', '•⌄•', '–ᴗ–'];
        }
    }

    _mascotStyleForState(state) {
        return `dip-mascot-state-${state}`;
    }

    _makeMascotActor(state = 'idle', sizeClass = 'dip-mascot-mini') {
        const actor = new St.BoxLayout({
            style_class: `dip-mascot ${sizeClass} ${this._mascotStyleForState(state)}`,
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });
        const face = new St.Label({
            text: this._mascotFaces(state)[0],
            style_class: 'dip-mascot-face',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        actor.add_child(face);
        actor._dipFaceLabel = face;
        actor._dipMascotState = state;
        return actor;
    }

    _setMascotActorState(actor, state, animate = false) {
        if (!actor || !actor._dipFaceLabel)
            return;
        const old = actor._dipMascotState || 'idle';
        if (old !== state) {
            actor.remove_style_class_name(this._mascotStyleForState(old));
            actor.add_style_class_name(this._mascotStyleForState(state));
            actor._dipMascotState = state;
            if (animate) {
                actor.set_scale(0.82, 0.82);
                actor.opacity = 180;
                actor.ease({
                    scale_x: 1,
                    scale_y: 1,
                    opacity: 255,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
        const frames = this._mascotFaces(state);
        actor._dipFaceLabel.text = frames[this._mascotFrame % frames.length];
    }

    _primaryMascotAgent() {
        const pending = this._agents.find(a => a.pending);
        if (pending)
            return pending;

        const active = this._agents.find(a => !['done', 'ended'].includes(safeText(a.status).toLowerCase()));
        if (active)
            return active;

        // Briefly celebrate a completed task, then return the collapsed island
        // to its normal media/clock presentation.
        const now = Date.now() / 1000;
        return this._agents.find(a => {
            const status = safeText(a.status).toLowerCase();
            const age = now - Number(a.updated || 0);
            return ['done', 'ended'].includes(status) && age >= 0 && age < 8;
        }) || null;
    }

    _collapsedMascotContext() {
        if (this._transient) {
            return {
                state: this._transient.mascotState || 'working',
                key: `transient:${safeText(this._transient.text)}:${safeText(this._transient.value)}`,
            };
        }

        const primary = this._primaryMascotAgent();
        if (primary) {
            return {
                state: this._mascotStateForAgent(primary),
                key: `agent:${safeText(primary.id || primary.agent)}:${safeText(primary.status)}:${safeText(primary.summary)}`,
            };
        }

        if (this._mediaState.hasPlayer) {
            return {
                state: this._mediaState.playing ? 'music' : 'paused',
                key: `media:${safeText(this._mediaState.bus)}:${safeText(this._mediaState.title)}:${this._mediaState.playing}`,
            };
        }

        if (this._batteryState?.charging) {
            return {state: 'charging', key: `charging:${this._batteryState.pct}`};
        }
        if (Number(this._batteryState?.pct) <= 20)
            return {state: 'battery-low', key: `battery:${this._batteryState.pct}`};

        if (this._lastNetworkOnline === false)
            return {state: 'offline', key: 'network:offline'};

        return {state: 'idle', key: 'idle'};
    }

    _updateMascots(animate = false) {
        const primary = this._primaryMascotAgent();
        const collapsed = this._collapsedMascotContext();
        const changed = collapsed.state !== this._mascotState || collapsed.key !== this._mascotContextKey;
        this._mascotState = collapsed.state;
        this._mascotContextKey = collapsed.key;
        this._mascotAgentId = primary ? safeText(primary.id || primary.agent) : '';

        // The collapsed island always has a mascot. System/media/agent state
        // changes the expression instead of swapping the mascot out for an icon.
        if (this._collapsedMascot) {
            this._collapsedMascot.visible = true;
            this._collapsedIcon.visible = false;
            this._setMascotActorState(this._collapsedMascot, collapsed.state, animate || changed);
        }

        // The Agents page remains agent-specific, even while the collapsed
        // mascot is reacting to media or system activity.
        if (this._agentPageMascot) {
            const agentState = this._mascotStateForAgent(primary);
            this._setMascotActorState(this._agentPageMascot, agentState, animate || changed);
        }
    }

    _initMascotAnimation() {
        const t = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 720, () => {
            this._mascotFrame = (this._mascotFrame + 1) % 12;
            this._updateMascots(false);
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(t);
    }

    _collapsedWidth() {
        if (this._transient)
            return CONTEXT_W;
        const pending = this._agents.find(a => a.pending);
        if (pending)
            return CONTEXT_W;
        const active = this._agents.find(a => !['done', 'ended'].includes(a.status));
        if (active)
            return CONTEXT_W;
        if (this._mediaState.hasPlayer)
            return CONTEXT_W;
        return IDLE_W;
    }

    _refreshCollapsed() {
        if (!this._collapsed || this._expanded)
            return;

        let icon = 'preferences-system-symbolic';
        let text = this._clockString || '';
        let value = '';

        if (this._transient) {
            icon = this._transient.icon;
            text = this._transient.text;
            value = this._transient.value || '';
        } else {
            const pending = this._agents.find(a => a.pending);
            const active = this._agents.find(a => !['done', 'ended'].includes(a.status));
            if (pending) {
                icon = pending.pending.kind === 'question' ? 'dialog-question-symbolic' : 'dialog-warning-symbolic';
                text = `${pending.agent || 'Agent'} needs you`;
                value = pending.pending.kind === 'question' ? 'Question' : 'Permission';
            } else if (active) {
                icon = 'applications-engineering-symbolic';
                text = `${active.agent || 'Agent'} · ${safeText(active.summary || active.status, 'Working')}`;
                value = safeText(active.tool || '');
            } else if (this._mediaState.hasPlayer) {
                icon = this._mediaState.playing ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
                text = this._mediaState.title || 'Media';
                value = this._mediaState.artist || '';
            }
        }

        this._updateMascots(false);
        this._collapsedIcon.icon_name = icon;
        this._collapsedLabel.text = text;
        this._collapsedValue.text = value;
        const w = this._collapsedWidth();
        if (this._island.width !== w) {
            const m = Main.layoutManager.primaryMonitor;
            const center = this._island.x + this._island.width / 2;
            const x = clamp(center - w / 2, m.x, m.x + m.width - w);
            this._island.ease({width: w, x, duration: 130, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _showTransient(icon, text, value = '', timeoutMs = 1700, mascotState = 'working') {
        this._transient = {icon, text, value, mascotState};
        if (this._transientTimeout) {
            try { GLib.source_remove(this._transientTimeout); } catch (_) {}
        }
        this._refreshCollapsed();
        this._transientTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            this._transientTimeout = 0;
            this._transient = null;
            this._refreshCollapsed();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._transientTimeout);
    }

    _positionFile() {
        const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'dynamic-island-plus-v2']);
        try { GLib.mkdir_with_parents(dir, 0o755); } catch (_) {}
        return GLib.build_filenamev([dir, 'position.ini']);
    }

    _loadPosition() {
        try {
            const k = new GLib.KeyFile();
            k.load_from_file(this._positionFile(), GLib.KeyFileFlags.NONE);
            return {cx: k.get_double('Position', 'center-x'), y: k.get_double('Position', 'y')};
        } catch (_) {
            return {cx: null, y: 8};
        }
    }

    _savePosition() {
        try {
            const k = new GLib.KeyFile();
            k.set_double('Position', 'center-x', this._position.cx);
            k.set_double('Position', 'y', this._position.y);
            k.save_to_file(this._positionFile());
        } catch (e) {
            logError(e, `${UUID}: failed to save position`);
        }
    }

    _positionIsland() {
        if (!this._island || this._dragging)
            return;
        const m = Main.layoutManager.primaryMonitor;
        const w = this._island.width || this._collapsedWidth();
        const cx = this._position.cx ?? m.width / 2;
        const yRel = this._position.y ?? 8;
        const x = clamp(m.x + cx - w / 2, m.x, m.x + m.width - w);
        const y = clamp(m.y + yRel, m.y, m.y + Math.min(TOP_LIMIT, m.height * 0.18));
        this._island.set_position(Math.round(x), Math.round(y));
    }

    _isDescendant(actor, parent) {
        let a = actor;
        while (a) {
            if (a === parent) return true;
            a = a.get_parent?.() ?? null;
        }
        return false;
    }

    _onStageEvent(event) {
        if (!this._island)
            return Clutter.EVENT_PROPAGATE;
        const t = event.type();
        if (t === Clutter.EventType.BUTTON_PRESS && event.get_button?.() === 1) {
            const src = event.get_source?.();
            if (!this._isDescendant(src, this._island))
                return Clutter.EVENT_PROPAGATE;
            if (src instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this._dragCandidate = true;
            this._dragging = false;
            this._dragStartPointer = [x, y];
            this._dragStartPos = [this._island.x, this._island.y];
            return Clutter.EVENT_PROPAGATE;
        }
        if (t === Clutter.EventType.MOTION && (this._dragCandidate || this._dragging)) {
            const [x, y] = event.get_coords();
            const dx = x - this._dragStartPointer[0];
            const dy = y - this._dragStartPointer[1];
            if (!this._dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD)
                return Clutter.EVENT_PROPAGATE;
            this._dragging = true;
            this._dragCandidate = false;
            const m = Main.layoutManager.primaryMonitor;
            const nx = clamp(this._dragStartPos[0] + dx, m.x, m.x + m.width - this._island.width);
            const ny = clamp(this._dragStartPos[1] + dy, m.y, m.y + Math.min(TOP_LIMIT, m.height * 0.18));
            this._island.set_position(Math.round(nx), Math.round(ny));
            return Clutter.EVENT_STOP;
        }
        if (t === Clutter.EventType.BUTTON_RELEASE && (this._dragCandidate || this._dragging)) {
            const didDrag = this._dragging;
            this._dragCandidate = false;
            this._dragging = false;
            if (!didDrag)
                return Clutter.EVENT_PROPAGATE;
            const m = Main.layoutManager.primaryMonitor;
            let center = this._island.x + this._island.width / 2;
            const exact = m.x + m.width / 2;
            if (Math.abs(center - exact) <= SNAP_PX)
                center = exact;
            this._position.cx = center - m.x;
            this._position.y = this._island.y - m.y;
            this._savePosition();
            this._positionIsland();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _initOsdMirror() {
        if (!Main.osdWindowManager || typeof Main.osdWindowManager.show !== 'function')
            return;
        this._originalOsdShow = Main.osdWindowManager.show;
        const ext = this;
        Main.osdWindowManager.show = function(...args) {
            const ret = ext._originalOsdShow.apply(this, args);
            try { ext._mirrorOsd(args); } catch (e) { logError(e, `${UUID}: OSD mirror`); }
            return ret;
        };
    }

    _mirrorOsd(args) {
        const icon = args[1];
        const label = args[2];
        const level = args[3];
        const maxLevel = args[4] || 1;
        let iconName = '';
        try { iconName = icon?.to_string?.() || icon?.toString?.() || ''; } catch (_) {}
        const pct = typeof level === 'number' ? `${Math.round(clamp(level / maxLevel, 0, 1) * 100)}%` : '';
        if (iconName.includes('audio') || iconName.includes('volume'))
            this._showTransient(iconName.includes('muted') ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic', safeText(label, 'Volume') || 'Volume', pct, 1700, iconName.includes('muted') ? 'muted' : 'volume');
        else if (iconName.includes('display-brightness') || iconName.includes('brightness'))
            this._showTransient('display-brightness-symbolic', safeText(label, 'Brightness') || 'Brightness', pct, 1700, 'brightness');
        else if (iconName.includes('keyboard-brightness'))
            this._showTransient('keyboard-brightness-symbolic', safeText(label, 'Keyboard brightness') || 'Keyboard brightness', pct, 1700, 'brightness');
    }

    _initMedia() {
        try {
            const r = Gio.DBus.session.call_sync(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
                null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, null
            );
            const [names] = unpack(r);
            for (const name of names || []) {
                if (name.startsWith('org.mpris.MediaPlayer2.'))
                    this._addPlayer(name);
            }
        } catch (e) {
            logError(e, `${UUID}: MPRIS discovery`);
        }
        const sub = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = unpack(params);
                if (!name?.startsWith('org.mpris.MediaPlayer2.')) return;
                if (newOwner && !oldOwner) this._addPlayer(name);
                else if (oldOwner && !newOwner) this._removePlayer(name);
            }
        );
        this._dbusSubs.push(sub);
    }

    _addPlayer(bus) {
        if (this._players.has(bus)) return;
        try {
            const proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                bus, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', null
            );
            const changedId = proxy.connect('g-properties-changed', () => this._refreshMedia());
            this._players.set(bus, {proxy, changedId});
            this._refreshMedia();
        } catch (_) {}
    }

    _removePlayer(bus) {
        const p = this._players.get(bus);
        if (p) {
            try { if (p.changedId) p.proxy.disconnect(p.changedId); } catch (_) {}
        }
        this._players.delete(bus);
        if (this._activePlayer === bus)
            this._activePlayer = null;
        this._refreshMedia();
    }

    _refreshMedia() {
        let chosen = null;
        let fallback = null;
        for (const [bus, p] of this._players) {
            try {
                const status = safeText(unpack(p.proxy.get_cached_property('PlaybackStatus')), 'Stopped');
                const entry = {bus, p, status};
                if (!fallback) fallback = entry;
                if (status === 'Playing') { chosen = entry; break; }
            } catch (_) {}
        }
        chosen = chosen || fallback;
        if (!chosen) {
            this._activePlayer = null;
            this._mediaState = {hasPlayer: false, playing: false, title: 'No media active', artist: '', bus: null};
            this._renderMedia();
            return;
        }
        this._activePlayer = chosen.bus;
        let md = {};
        try { md = unpack(chosen.p.proxy.get_cached_property('Metadata')) || {}; } catch (_) {}
        const get = key => unpack(md[key]);
        const title = safeText(get('xesam:title'), 'Unknown track');
        let artist = get('xesam:artist');
        if (Array.isArray(artist)) artist = artist.join(', ');
        artist = safeText(artist, safeText(get('xesam:album'), ''));
        this._mediaState = {
            hasPlayer: true,
            playing: chosen.status === 'Playing',
            title,
            artist,
            bus: chosen.bus,
        };
        this._renderMedia();
    }

    _renderMedia() {
        if (!this._mediaTitle) return;
        this._mediaTitle.text = this._mediaState.title;
        this._mediaArtist.text = this._mediaState.artist || (this._mediaState.hasPlayer ? 'MPRIS media player' : 'Start playback in an MPRIS-compatible app');
        this._playButton.get_child().icon_name = this._mediaState.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._updateMascots(true);
        this._refreshCollapsed();
    }

    _mprisCall(method) {
        if (!this._activePlayer) return;
        const p = this._players.get(this._activePlayer);
        if (!p) return;
        try {
            p.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (_) {}
    }

    _initSystem() {
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        if (this._networkMonitor) {
            const id = this._networkMonitor.connect('network-changed', () => this._updateSystem());
            this._signals.push([this._networkMonitor, id]);
        }
        this._lastCpu = null;
        this._updateSystem();
        const t = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._updateSystem();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(t);

        const c = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(c);
    }

    _readText(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok) return '';
            return new TextDecoder().decode(bytes);
        } catch (_) {
            return '';
        }
    }

    _updateSystem() {
        try {
            const stat = this._readText('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
            if (stat.length >= 4) {
                const idle = stat[3] + (stat[4] || 0);
                const total = stat.reduce((a, b) => a + b, 0);
                if (this._lastCpu) {
                    const dt = total - this._lastCpu.total;
                    const di = idle - this._lastCpu.idle;
                    const pct = dt > 0 ? Math.round((1 - di / dt) * 100) : 0;
                    this._status_cpu.text = `${clamp(pct, 0, 100)}%`;
                }
                this._lastCpu = {total, idle};
            }
        } catch (_) {}
        try {
            const mem = {};
            for (const line of this._readText('/proc/meminfo').split('\n')) {
                const m = line.match(/^(\w+):\s+(\d+)/);
                if (m) mem[m[1]] = Number(m[2]);
            }
            if (mem.MemTotal) {
                const avail = mem.MemAvailable ?? mem.MemFree ?? 0;
                const used = mem.MemTotal - avail;
                this._status_ram.text = `${Math.round(used / mem.MemTotal * 100)}%`;
            }
        } catch (_) {}
        try {
            const online = Boolean(this._networkMonitor?.network_available);
            const connectivity = this._networkMonitor?.connectivity;
            this._status_network.text = online ? (connectivity === Gio.NetworkConnectivity.FULL ? 'Online' : 'Connected') : 'Offline';
            if (this._lastNetworkOnline !== null && online !== this._lastNetworkOnline) {
                this._showTransient(
                    online ? 'network-wireless-signal-excellent-symbolic' : 'network-offline-symbolic',
                    online ? 'Network connected' : 'Network offline',
                    online ? 'Online' : 'Offline', 2200, online ? 'network' : 'offline');
            }
            this._lastNetworkOnline = online;
            this._updateMascots(false);
        } catch (_) {}
    }

    _updateClock() {
        const dt = GLib.DateTime.new_now_local();
        this._clockString = dt.format('%H:%M');
        if (this._clockDetail)
            this._clockDetail.text = dt.format('%A, %d %B %Y · %H:%M:%S');
        this._refreshCollapsed();
    }

    _initBattery() {
        try {
            this._batteryProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
                'org.freedesktop.UPower.Device', null
            );
            const id = this._batteryProxy.connect('g-properties-changed', () => this._updateBattery());
            this._signals.push([this._batteryProxy, id]);
            this._lastBatteryPct = null;
            this._updateBattery();
        } catch (_) {
            if (this._status_battery) this._status_battery.text = 'Unavailable';
        }
    }

    _updateBattery() {
        if (!this._batteryProxy || !this._status_battery) return;
        try {
            const pct = Math.round(Number(unpack(this._batteryProxy.get_cached_property('Percentage'))) || 0);
            const state = Number(unpack(this._batteryProxy.get_cached_property('State'))) || 0;
            const empty = Number(unpack(this._batteryProxy.get_cached_property('TimeToEmpty'))) || 0;
            const full = Number(unpack(this._batteryProxy.get_cached_property('TimeToFull'))) || 0;
            const charging = state === 1;
            const suffix = charging ? ` · ${fmtSeconds(full)} to full` : (empty > 0 ? ` · ${fmtSeconds(empty)} left` : '');
            this._status_battery.text = `${pct}%${suffix}`;
            this._batteryState = {pct, charging, empty, full};
            if (this._lastBatteryCharging !== null && charging !== this._lastBatteryCharging) {
                this._showTransient(
                    charging ? 'battery-good-charging-symbolic' : 'battery-good-symbolic',
                    charging ? 'Charging started' : 'Running on battery',
                    `${pct}%`, 2200, charging ? 'charging' : 'battery-low');
            }
            if (this._lastBatteryPct !== null && pct !== this._lastBatteryPct) {
                if ([20, 10, 5].includes(pct) || (pct < 20 && pct % 5 === 0))
                    this._showTransient('battery-low-symbolic', `Battery ${pct}%`, charging ? 'Charging' : fmtSeconds(empty), 2600, charging ? 'charging' : 'battery-low');
            }
            this._lastBatteryPct = pct;
            this._lastBatteryCharging = charging;
            this._updateMascots(false);
        } catch (_) {}
    }

    _initBluetooth() {
        this._btDevices = new Map();
        try {
            const res = Gio.DBus.system.call_sync(
                'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
                null, new GLib.VariantType('(a{oa{sa{sv}}})'), Gio.DBusCallFlags.NONE, -1, null
            );
            const [objects] = unpack(res);
            for (const [path, ifaces] of Object.entries(objects || {}))
                this._consumeBluezObject(path, ifaces, false);
        } catch (_) {
            if (this._status_bluetooth) this._status_bluetooth.text = 'Unavailable';
            return;
        }
        const propSub = Gio.DBus.system.signal_subscribe(
            'org.bluez', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, 'org.bluez.Device1',
            Gio.DBusSignalFlags.NONE,
            (_c, _s, path, _i, _sig, params) => {
                const [_iface, changed] = unpack(params);
                if (!changed || !('Connected' in changed) && !('Alias' in changed) && !('Name' in changed)) return;
                const old = this._btDevices.get(path) || {connected: false, name: 'Bluetooth device'};
                const now = {
                    connected: 'Connected' in changed ? Boolean(unpack(changed.Connected)) : old.connected,
                    name: safeText('Alias' in changed ? unpack(changed.Alias) : ('Name' in changed ? unpack(changed.Name) : old.name), old.name),
                };
                this._btDevices.set(path, now);
                if (now.connected !== old.connected)
                    this._showTransient('bluetooth-active-symbolic', now.name, now.connected ? 'Connected' : 'Disconnected', 2200, 'bluetooth');
                this._updateBluetoothSummary();
            }
        );
        this._dbusSubs.push(propSub);
    }

    _consumeBluezObject(path, ifaces, announce) {
        const dev = ifaces?.['org.bluez.Device1'];
        if (!dev) return;
        const connected = Boolean(unpack(dev.Connected));
        const name = safeText(unpack(dev.Alias) || unpack(dev.Name), 'Bluetooth device');
        this._btDevices.set(path, {connected, name});
        if (announce && connected)
            this._showTransient('bluetooth-active-symbolic', name, 'Connected', 1700, 'bluetooth');
        this._updateBluetoothSummary();
    }

    _updateBluetoothSummary() {
        if (!this._status_bluetooth) return;
        const connected = [...this._btDevices.values()].filter(d => d.connected);
        this._status_bluetooth.text = connected.length ? (connected.length === 1 ? connected[0].name : `${connected.length} devices`) : 'No devices';
    }

    _initNotifications() {
        if (!Main.messageTray) return;
        const attach = source => {
            if (!source || source.__dipAttached) return;
            try {
                source.__dipAttached = true;
                const id = source.connect('notification-added', (_s, n) => this._captureNotification(source, n));
                this._signals.push([source, id]);
            } catch (_) {}
        };
        try {
            const current = Main.messageTray.getSources?.() || Main.messageTray._sources || [];
            for (const s of current) attach(s);
        } catch (_) {}
        try {
            const id = Main.messageTray.connect('source-added', (_tray, source) => attach(source));
            this._signals.push([Main.messageTray, id]);
        } catch (_) {}
    }

    _captureNotification(source, n) {
        const title = safeText(n?.title || source?.title, 'Notification');
        const body = safeText(n?.body || n?.bannerBodyText || '', '');
        this._notifications.unshift({title, body, time: Date.now()});
        this._notifications = this._notifications.slice(0, 6);
        this._rebuildNotifications();
        this._showTransient('preferences-system-notifications-symbolic', title, body, 2300, 'notification');
    }

    _rebuildNotifications() {
        if (!this._notifList) return;
        this._notifList.destroy_all_children();
        if (!this._notifications.length) {
            this._notifList.add_child(new St.Label({text: 'No recent notifications captured', style_class: 'dip-empty'}));
            return;
        }
        for (const n of this._notifications.slice(0, 4)) {
            const row = new St.BoxLayout({vertical: true, style_class: 'dip-notif-row'});
            const title = new St.Label({text: n.title, style_class: 'dip-notif-title'});
            const body = new St.Label({text: n.body || ' ', style_class: 'dip-notif-body'});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(title);
            row.add_child(body);
            this._notifList.add_child(row);
        }
    }

    _initDesktopFocus() {
        // Ordinary Chat has no lifecycle stream. React only to observed focus.
        const tracker = Shell.WindowTracker.get_default();
        let lastApp = '';
        const id = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            const app = win ? tracker.get_window_app(win) : null;
            const name = app ? safeText(app.get_name()) : '';
            if (name === lastApp) return;
            const previous = lastApp;
            lastApp = name;
            if (/chatgpt|codex/i.test(name))
                this._showTransient('dialog-information-symbolic', `${name} · Focused`, '', 1700, 'working');
            else if (/chatgpt|codex/i.test(previous))
                this._showTransient('dialog-information-symbolic', `${previous} · In background`, '', 1400, 'idle');
        });
        this._signals.push([global.display, id]);
    }

    _initAgentPolling() {
        const t = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._pollAgentState();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(t);
        this._pollAgentState();
    }

    _pollAgentState() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._statePath);
            if (!ok) return;
            const text = new TextDecoder().decode(bytes);
            if (text === this._lastAgentJson) return;
            this._lastAgentJson = text;
            const data = JSON.parse(text);
            this._agents = Array.isArray(data.sessions) ? data.sessions : [];
            this._renderAgents();
            const pending = this._agents.find(a => a.pending);
            if (pending && !this._expanded) {
                this._switchPage('agents');
                this._expand();
            }
            this._refreshCollapsed();
        } catch (_) {
            if (this._agents.length) {
                this._agents = [];
                this._renderAgents();
                this._updateMascots(true);
                this._refreshCollapsed();
            }
        }
    }

    _renderAgents() {
        if (!this._agentsList) return;
        this._agentsList.destroy_all_children();
        if (!this._agents.length) {
            this._agentsSummary.text = 'No AI agents connected';
            this._setMascotActorState(this._agentPageMascot, 'idle', true);
            this._agentsList.add_child(new St.Label({text: 'Enable the Dynamic Island Plus plugin in ChatGPT Work or Codex.', style_class: 'dip-empty'}));
            return;
        }
        const activeCount = this._agents.filter(a => !['done', 'ended'].includes(a.status)).length;
        const pendingCount = this._agents.filter(a => a.pending).length;
        this._agentsSummary.text = pendingCount ? `${pendingCount} waiting for you` : `${activeCount} active agent${activeCount === 1 ? '' : 's'}`;
        this._updateMascots(true);

        for (const a of [...this._agents].sort((a, b) => Number(Boolean(b.pending)) - Number(Boolean(a.pending))).slice(0, 4)) {
            const card = new St.BoxLayout({style_class: 'dip-agent-card', vertical: true, x_expand: true});
            const head = new St.BoxLayout({vertical: false, x_expand: true});
            const cardMascot = this._makeMascotActor(this._mascotStateForAgent(a), 'dip-mascot-tiny');
            const name = new St.Label({text: safeText(a.agent, 'Agent'), style_class: 'dip-agent-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const status = new St.Label({text: safeText(a.status, 'working'), style_class: 'dip-agent-status', y_align: Clutter.ActorAlign.CENTER});
            head.add_child(cardMascot); head.add_child(name); head.add_child(status);
            card.add_child(head);
            const summary = new St.Label({text: safeText(a.summary || a.tool || 'Working…'), style_class: 'dip-agent-summary'});
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            card.add_child(summary);

            if (a.pending) {
                const p = a.pending;
                const detail = new St.Label({
                    text: safeText(p.detail || p.question || p.tool || 'Input required'),
                    style_class: 'dip-pending-detail',
                });
                detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                card.add_child(detail);

                const buttons = new St.BoxLayout({vertical: false, style_class: 'dip-approval-row'});
                if (p.kind === 'question' && Array.isArray(p.options)) {
                    for (const opt of p.options.slice(0, 4)) {
                        const b = new St.Button({label: safeText(opt), style_class: 'dip-choice-button', x_expand: true});
                        b.connect('clicked', () => this._writeAgentResponse(p.request_id, {answer: opt}));
                        buttons.add_child(b);
                    }
                } else {
                    const deny = new St.Button({label: 'Deny', style_class: 'dip-deny-button', x_expand: true});
                    const allow = new St.Button({label: 'Allow', style_class: 'dip-allow-button', x_expand: true});
                    deny.connect('clicked', () => this._writeAgentResponse(p.request_id, {decision: 'deny'}));
                    allow.connect('clicked', () => this._writeAgentResponse(p.request_id, {decision: 'allow'}));
                    buttons.add_child(deny); buttons.add_child(allow);
                }
                card.add_child(buttons);
            }
            this._agentsList.add_child(card);
        }
    }

    _writeAgentResponse(requestId, response) {
        if (!/^[a-f0-9]{32}$/.test(requestId)) return;
        const path = GLib.build_filenamev([this._responsesDir, `${requestId}.json`]);
        try {
            GLib.file_set_contents(path, JSON.stringify(response));
            this._showTransient('emblem-ok-symbolic', response.decision === 'deny' ? 'Denied' : 'Sent to agent', response.answer || '', 1100, response.decision === 'deny' ? 'error' : 'success');
        } catch (e) {
            logError(e, `${UUID}: response write`);
        }
    }
}
