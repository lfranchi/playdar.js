Playdar = {
    VERSION: "0.4.6",
    SERVER_ROOT: "localhost",
    SERVER_PORT: "60210",
    STATIC_HOST: "http://www.playdar.org",
    STAT_TIMEOUT: 2000,
    AUTH_COOKIE_NAME: "Playdar.Auth",
    AUTH_POPUP_NAME: "Playdar.AuthPopup",
    AUTH_POPUP_SIZE: {
        'w': 500,
        'h': 260
    },
    QUERIES_POPUP_NAME: "Playdar.QueriesPopup",
    QUERIES_POPUP_SIZE: {
        'w': 640,
        'h': 700
    },
    MAX_POLLS: 4,
    MAX_CONCURRENT_RESOLUTIONS: 5,
    USE_STATUS_BAR: true,
    USE_SCROBBLER: true,
    
    client: null,
    status_bar: null,
    player: null,
    setup: function (auth_details) {
        var auth_details = auth_details || {};
        // Set default details
        auth_details.name = auth_details.name
                         || window.document.title;
        auth_details.website = auth_details.website
                            || window.location.protocol + '//' + window.location.host + '/';
        // Convert a relative path to an absolute one
        if (auth_details.receiverurl) {
            auth_details.receiverurl = Playdar.Util.location_from_url(auth_details.receiverurl).href;
        }
        new Playdar.Client(auth_details);
        new Playdar.Boffin();
    },
    setup_player: function (soundmanager) {
        new Playdar.Player(soundmanager);
    },
    unload: function () {
        if (Playdar.player) {
            // Stop the music
            Playdar.player.stop_current(true);
        } else if (Playdar.scrobbler) {
            // Stop scrobbling
            Playdar.scrobbler.stop();
        }
    }
};

Playdar.DefaultListeners = {
    onStat: function (detected) {
        if (detected) {
            // Playdar detected
        } else {
            // Playdar not found
        }
    },
    onAuth: function () {
        // Playdar authorised
    },
    onAuthClear: function () {
        // Playdar deauthorised
    },
    onResults: function (response, final_answer) {
        if (final_answer) {
            if (response.results.length) {
                // Found results
            } else {
                // No results
            }
        } else {
            // Still polling
        }
    },
    onTagCloud: function (response) {
        // Tag cloud response
    },
    onRQL: function (response) {
        // RQL playlist response
    },
    onResolveIdle: function () {
        // Resolution queue is empty and nothing in progress
    }
};

Playdar.Client = function (auth_details, listeners) {
    Playdar.client = this;
    
    this.auth_token = false;
    this.auth_popup = null;
    
    this.listeners = {};
    this.results_handlers = {};
    
    this.resolve_qids = [];
    this.last_qid = "";
    this.poll_counts = {};
    
    /**
     * A query resolution queue consumed by process_resolution_queue, which is called
     * each time a final_answer is received from the daemon.
    **/
    this.initialise_resolve();
    
    // Setup auth
    this.auth_details = auth_details;
    // Setup listeners
    this.register_listeners(Playdar.DefaultListeners);
    this.register_listeners(listeners);
    
    this.uuid = Playdar.Util.generate_uuid();
};
Playdar.Client.prototype = {
    register_listener: function (event, callback) {
        callback = callback || Playdar.Util.null_callback;
        this.listeners[event] = function () { return callback.apply(Playdar.client, arguments); };
    },
    register_listeners: function (listeners) {
        if (!listeners) {
            return;
        }
        for (var event in listeners) {
            this.register_listener(event, listeners[event]);
        }
        return true;
    },
    // Custom search result handlers can be bound to a specific qid
    register_results_handler: function (handler, qid) {
        if (qid) {
            this.results_handlers[qid] = handler;
        } else {
            this.register_listener('onResults', handler);
        }
    },
    
    // INIT / STAT / AUTH
    
    init: function () {
        if (!this.is_authed()) {
            this.auth_token = Playdar.Util.getcookie(Playdar.AUTH_COOKIE_NAME);
        }
        this.stat();
    },
    
    stat: function () {
        setTimeout(function () {
            Playdar.client.check_stat_timeout();
        }, Playdar.STAT_TIMEOUT);
        Playdar.Util.loadjs(this.get_url("stat", "handle_stat"));
    },
    check_stat_timeout: function () {
        if (!this.stat_response || this.stat_response.name != "playdar") {
            this.listeners.onStat(false);
        }
    },
    handle_stat: function (response) {
        this.stat_response = response;
        // Update status bar
        if (Playdar.USE_STATUS_BAR) {
            new Playdar.StatusBar();
            Playdar.status_bar.handle_stat(response);
        }
        this.listeners.onStat(response);
        
        if (response.authenticated) {
            // Setup scrobbling if we haven't already, if it's enabled globally
            // and if the daemon has it enabled
            if (!Playdar.scrobbler && Playdar.USE_SCROBBLER && response.capabilities.audioscrobbler) {
                new Playdar.Scrobbler();
            }
            this.listeners.onAuth();
        } else if (this.is_authed()) {
            this.clear_auth();
        }
    },
    clear_auth: function () {
        Playdar.unload();
        // Revoke auth at the server
        Playdar.Util.loadjs(this.get_revoke_url());
        // Clear auth token
        this.auth_token = false;
        Playdar.Util.deletecookie(Playdar.AUTH_COOKIE_NAME);
        // Callback
        this.listeners.onAuthClear();
        // Update status bar
        if (Playdar.status_bar) {
            Playdar.status_bar.offline();
        }
    },
    is_authed: function () {
        if (this.auth_token) {
            return true;
        }
        return false;
    },
    get_revoke_url: function () {
        return this.get_base_url("/authcodes", {
            revoke: this.auth_token,
            jsonp: 'Playdar.Util.null_callback'
        });
    },
    get_auth_url: function () {
        return this.get_base_url("/auth_1/", this.auth_details);
    },
    get_auth_link_html: function (title) {
        title = title || "Connect";
        var html = '<a href="' + this.get_auth_url()
            + '" target="' + Playdar.AUTH_POPUP_NAME
            + '" onclick="Playdar.client.start_auth(); return false;'
        + '">' + title + '</a>';
        return html;
    },
    get_disconnect_link_html: function (text) {
        text = text || "Disconnect";
        var html = '<a href="' + this.get_revoke_url()
            + '" onclick="Playdar.client.clear_auth(); return false;'
        + '">' + text + '</a>';
        return html;
    },
    start_auth: function () {
        if (!this.auth_popup || this.auth_popup.closed) {
            this.auth_popup = window.open(
                this.get_auth_url(),
                Playdar.AUTH_POPUP_NAME,
                Playdar.Util.get_popup_options(Playdar.AUTH_POPUP_SIZE)
            );
        } else {
            this.auth_popup.focus();
        }
        if (!this.auth_details.receiverurl) {
            // Show manual auth form
            if (Playdar.status_bar) {
                Playdar.status_bar.start_manual_auth();
            }
        }
    },
    
    auth_callback: function (token) {
        Playdar.Util.setcookie(Playdar.AUTH_COOKIE_NAME, token, 365);
        if (this.auth_popup && !this.auth_popup.closed) {
            this.auth_popup.close();
            this.auth_popup = null;
        }
        this.auth_token = token;
        this.stat();
    },
    manual_auth_callback: function (input_id) {
        var input = document.getElementById(input_id);
        if (input && input.value) {
            this.auth_callback(input.value);
        }
    },
    
    /**
     * Playdar.client.autodetect([callback][, context])
     * - callback (Function): Function to be run for each track to be resolved
     *      Will be passed the track object. If this returns a qid, it will be
     *      passed on to the resolve call.
     * - context (DOMElement): A DOM node to use to scope the selector
     * 
     * Attempts to detect any mentions of a track on a page or within a node
     * and resolves them.
    **/
    autodetect: function (callback, context) {
        if (!this.is_authed()) {
            return false;
        }
        var qid, i, j, list, track;
        try {
            var mf = Playdar.Parse.microformats(context);
            var rdfa = Playdar.Parse.rdfa(context);
            var data = mf.concat(rdfa);
            for (i = 0; i < data.length; i++) {
                list = data[i];
                for (j = 0; j < list.tracks.length; j++) {
                    track = list.tracks[j];
                    if (callback) {
                        qid = callback(track);
                    }
                    this.resolve(track.artist, track.album, track.title, qid);
                }
            }
            return data;
        } catch (error) {
            console.warn(error);
        }
    },
    
    // CONTENT RESOLUTION
    
    resolve: function (artist, album, track, qid, url) {
        if (!this.is_authed()) {
            return false;
        }
        var query = {
            artist: artist || '',
            album: album || '',
            track: track || '',
            url: url || '',
            qid: qid || Playdar.Util.generate_uuid()
        };
        // List player's supported mimetypes
        if (Playdar.player) {
            query.mimetypes = Playdar.player.get_mime_types().join(',');
        }
        // Update resolving progress status
        if (Playdar.status_bar) {
            Playdar.status_bar.increment_requests();
        }
        
        this.resolution_queue.push(query);
        this.process_resolution_queue();
    },
    process_resolution_queue: function() {
        if (this.resolutions_in_progress.count >= Playdar.MAX_CONCURRENT_RESOLUTIONS) {
            return false;
        }
        // Check we've got nothing queued up or in progress
        var resolution_count = this.resolution_queue.length + this.resolutions_in_progress.count;
        if (resolution_count) {
            var available_resolution_slots = Playdar.MAX_CONCURRENT_RESOLUTIONS - this.resolutions_in_progress.count;
            for (var i = 1; i <= available_resolution_slots; i++) {
                var query = this.resolution_queue.shift();
                if (!query) {
                    break;
                }
                this.resolutions_in_progress.queries[query.qid] = query;
                this.resolutions_in_progress.count++;
                Playdar.Util.loadjs(this.get_url("resolve", "handle_resolution", query));
            }
        } else {
            this.listeners.onResolveIdle();
        }
    },
    cancel_resolve: function () {
        this.initialise_resolve();
        if (Playdar.status_bar) {
            Playdar.status_bar.cancel_resolve();
        }
    },
    initialise_resolve: function () {
        this.resolution_queue = [];
        this.resolutions_in_progress = {
            count: 0,
            queries: {}
        };
    },
    recheck_results: function (qid) {
        var query = {
            qid: qid 
        };
        this.resolutions_in_progress.queries[qid] = query;
        this.resolutions_in_progress.count++;
        this.handle_resolution(query);
    },
    handle_resolution: function (query) {
        // Check resolving hasn't been cancelled
        if (this.resolutions_in_progress.queries[query.qid]) {
            this.last_qid = query.qid;
            this.resolve_qids.push(this.last_qid);
            this.get_results(query.qid);
        }
    },
    
    // poll results for a query id
    get_results: function (qid) {
        // Check resolving hasn't been cancelled
        if (this.resolutions_in_progress.queries[qid]) {
            if (!this.poll_counts[qid]) {
                this.poll_counts[qid] = 0;
            }
            this.poll_counts[qid]++;
            Playdar.Util.loadjs(this.get_url("get_results", "handle_results", {
                qid: qid,
                poll: this.poll_counts[qid]
            }));
        }
    },
    poll_results: function (response, callback, scope) {
        // figure out if we should re-poll, or if the query is solved/failed:
        var final_answer = this.should_stop_polling(response);
        scope = scope || this;
        if (!final_answer) {
            setTimeout(function () {
                callback.call(scope, response.qid);
            }, response.poll_interval || response.refresh_interval);
            // response.refresh_interval is deprecated.
        }
        return final_answer;
    },
    should_stop_polling: function (response) {
        // Stop if the server tells us to
        // response.refresh_interval is deprecated. (undefined <= 0 === false)
        if (response.poll_interval <= 0 || response.refresh_interval <= 0) {
            return true;
        }
        // Stop if the query is solved
        if (response.solved === true) {
            return true;
        }
        // Stop if we've exceeded our poll limit
        if (this.poll_counts[response.qid] >= (response.poll_limit || Playdar.MAX_POLLS)) {
            return true;
        }
        return false;
    },
    handle_results: function (response) {
        // Check resolving hasn't been cancelled
        if (this.resolutions_in_progress.queries[response.qid]) {
            var final_answer = this.poll_results(response, this.get_results);
            // Status bar handler
            if (Playdar.status_bar) {
                Playdar.status_bar.handle_results(response, final_answer);
            }
            if (this.results_handlers[response.qid]) {
                // try a custom handler registered for this query id
                this.results_handlers[response.qid](response, final_answer);
            } else {
                // fall back to standard handler
                this.listeners.onResults(response, final_answer);
            }
            // Check to see if we can make some more resolve calls
            if (final_answer) {
                delete this.resolutions_in_progress.queries[response.qid];
                this.resolutions_in_progress.count--;
                this.process_resolution_queue();
            }
        }
    },
    get_last_results: function () {
        if (this.last_qid) {
            if (Playdar.status_bar) {
                Playdar.status_bar.increment_requests();
            }
            this.get_results(this.last_qid);
        }
    },
    
    // UTILITY FUNCTIONS
    
    get_base_url: function (path, query_params) {
        var url = "http://" + Playdar.SERVER_ROOT + ":" + Playdar.SERVER_PORT;
        if (path) {
            url += path;
        }
        if (query_params) {
            url += '?' + Playdar.Util.toQueryString(query_params);
        }
        return url;
    },
    
    /**
     * Playdar.client.get_url(method, jsonp[, query_params]) -> String
     * - method (String): Method to call on the Playdar API
     * - jsonp (String | Array): JSONP Callback name.
     *     If a string, will be passed to Playdar.client.jsonp_callback to build
     *     a callback of the form Playdar.client.<callback>
     *     If an array, will be joined together with dot notation.
     * - query_params (Object): An optional object that defines extra query params
     * 
     * Builds an API URL from a method name, jsonp parameter and an optional object
     * of extra query parameters.
    **/
    get_url: function (method, jsonp, query_params) {
        query_params = query_params || {};
        query_params.call_id = new Date().getTime();
        query_params.method = method;
        if (!query_params.jsonp) {
            if (jsonp.join) { // duck type check for array
                query_params.jsonp = jsonp.join('.');
            } else {
                query_params.jsonp = this.jsonp_callback(jsonp);
            }
        }
        this.add_auth_token(query_params);
        return this.get_base_url("/api/", query_params);
    },
    
    add_auth_token: function (query_params) {
        if (this.is_authed()) {
            query_params.auth = this.auth_token;
        }
        return query_params;
    },
    
    // turn a source id into a stream url
    get_stream_url: function (sid) {
        return this.get_base_url("/sid/" + sid);
    },
    
    // build the jsonp callback string
    jsonp_callback: function (callback) {
        return "Playdar.client." + callback;
    },
    
    list_results: function (response) {
        for (var i = 0; i < response.results.length; i++) {
            console.log(response.results[i].name);
        }
    }
};

Playdar.Boffin = function () {
    Playdar.boffin = this;
};
Playdar.Boffin.prototype = {
    get_url: function (method, query_params) {
        query_params = query_params || {};
        query_params.call_id = new Date().getTime();
        query_params.jsonp = query_params.jsonp || 'Playdar.Util.null_callback';
        Playdar.client.add_auth_token(query_params);
        return Playdar.client.get_base_url("/boffin/" + method, query_params);
    },
    get_tagcloud: function () {
        // Update resolving progress status
        if (Playdar.status_bar) {
            Playdar.status_bar.increment_requests();
        }
        Playdar.client.resolutions_in_progress++;
        Playdar.Util.loadjs(this.get_url("tagcloud", {
            jsonp: 'Playdar.boffin.handle_tagcloud'
        }));
    },
    handle_tagcloud: function (response) {
        Playdar.client.register_results_handler(Playdar.client.listeners.onTagCloud, response.qid);
        Playdar.client.get_results(response.qid);
    },
    get_tag_rql: function (tag) {
        // Update resolving progress status
        if (Playdar.status_bar) {
            Playdar.status_bar.increment_requests();
        }
        Playdar.client.resolutions_in_progress++;
        var rql = 'tag:"' + tag + '"';
        Playdar.Util.loadjs(this.get_url("rql/" + encodeURIComponent(rql), {
            jsonp: 'Playdar.boffin.handle_rql'
        }));
    },
    handle_rql: function (response) {
        Playdar.client.register_results_handler(Playdar.client.listeners.onRQL, response.qid);
        Playdar.client.get_results(response.qid);
    }
};

Playdar.Scrobbler = function () {
    Playdar.scrobbler = this;
};
Playdar.Scrobbler.prototype = {
    get_url: function (method, query_params) {
        query_params = query_params || {};
        query_params.call_id = new Date().getTime();
        query_params.jsonp = query_params.jsonp || 'Playdar.Util.null_callback';
        Playdar.client.add_auth_token(query_params);
        return Playdar.client.get_base_url("/audioscrobbler/" + method, query_params);
    },
    
    start: function (artist, track, album, duration, track_number, mbid) {
        var query_params = {
            a: artist,
            t: track,
            o: 'P'
        };
        if (album) {
            query_params['b'] = album;
        }
        if (duration) {
            query_params['l'] = duration;
        }
        if (track_number) {
            query_params['n'] = track_number;
        }
        if (mbid) {
            query_params['m'] = mbid;
        }
        Playdar.Util.loadjs(this.get_url("start", query_params));
    },
    stop: function () {
        Playdar.Util.loadjs(this.get_url("stop"));
    },
    pause: function () {
        Playdar.Util.loadjs(this.get_url("pause"));
    },
    resume: function () {
        Playdar.Util.loadjs(this.get_url("resume"));
    },
    get_sound_callbacks: function (result) {
        var scrobbler = this;
        return {
            onload: function () {
                if (this.readyState == 2) { // failed/error
                    scrobbler.stop();
                    this.unload();
                }
            },
            onplay: function () {
                // scrobbler.start isn't called until the first whileplaying callback
                this.scrobbleStart = true;
            },
            onpause: function () {
                scrobbler.pause();
            },
            onresume: function () { 
                scrobbler.resume();
            },
            onfinish: function () {
                if (!this.chained) {
                    scrobbler.stop();
                }
            },
            whileplaying: function () {
                // At this point we've finished the initial buffer and are actually playing
                if (this.scrobbleStart) {
                    this.scrobbleStart = false;
                    scrobbler.start(result.artist, result.track, result.album, result.duration);
                }
            }
        };
    }
};

Playdar.Player = function (soundmanager) {
    Playdar.player = this;
    
    this.streams = {};
    this.nowplayingid = null;
    this.soundmanager = soundmanager;
};

// Those set to true are MPEG4 and require isMovieStar in soundmanager init
Playdar.Player.MIMETYPES = {
    "audio/mpeg": false,
    "audio/aac": true,
    "audio/x-aac": true,
    "audio/flv": true,
    "audio/mov": true,
    "audio/mp4": true,
    "audio/m4v": true,
    "audio/f4v": true,
    "audio/m4a": true,
    "audio/x-m4a": true,
    "audio/x-m4b": true,
    "audio/mp4v": true,
    "audio/3gp": true,
    "audio/3g2": true
};
Playdar.Player.prototype = {
    get_mime_types: function () {
        var mime_types = [];
        for (var type in Playdar.Player.MIMETYPES) {
            mime_types.push(type);
        }
        return mime_types;
    },
    register_stream: function (result, options) {
        if (this.streams[result.sid]) {
            return false;
        }
        // Register result
        this.streams[result.sid] = result;
        
        var sound_options = Playdar.Util.extend_object({
            id: 's_' + result.sid,
            url: Playdar.client.get_stream_url(result.sid),
            isMovieStar: Playdar.Player.MIMETYPES[result.mimetype] === true,
            bufferTime: 2
        }, options);
        
        var callback_options = [options];
        // Wrap sound progress callbacks with status bar
        if (Playdar.status_bar) {
            callback_options.push(Playdar.status_bar.get_sound_callbacks(result));
        }
        // Wrap sound lifecycle callbacks in scrobbling calls
        if (Playdar.scrobbler) {
            callback_options.push(Playdar.scrobbler.get_sound_callbacks(result));
        }
        Playdar.Util.extend_object(sound_options, Playdar.Util.merge_callback_options(callback_options));
        try {
            var sound = this.soundmanager.createSound(sound_options);
        } catch (e) {
            return false;
        }
        return sound;
    },
    play_stream: function (sid) {
        var sound = this.soundmanager.getSoundById('s_' + sid);
        if (this.nowplayingid != sid) {
            this.stop_current();
            if (sound.playState === 0) {
                this.nowplayingid = sid;
                // Update status bar
                if (Playdar.status_bar) {
                    Playdar.status_bar.play_handler(this.streams[sid]);
                }
            }
        }
        
        sound.togglePause();
        return sound;
    },
    stop_current: function (hard) {
        if (hard) {
            if (Playdar.scrobbler) {
                Playdar.scrobbler.stop();
            }
        }
        if (this.nowplayingid) {
            var sound = this.soundmanager.getSoundById('s_' + this.nowplayingid);
            if (sound.playState == 1) {
                sound.setPosition(1);
                sound.stop();
            }
            this.nowplayingid = null;
        }
        // Update status bar
        if (Playdar.status_bar) {
            Playdar.status_bar.stop_current();
        }
    },
    stop_stream: function (sid) {
        if (sid && sid == this.nowplayingid) {
            this.stop_current();
            return true;
        }
        return false;
    },
    is_now_playing: function () {
        if (this.nowplayingid) {
            return true;
        }
        return false;
    },
    toggle_nowplaying: function () {
        if (this.nowplayingid) {
            this.play_stream(this.nowplayingid);
        }
    }
};

Playdar.StatusBar = function () {
    Playdar.status_bar = this;
    
    this.queries_popup = null;
    
    this.progress_bar_width = 200;
    
    this.request_count = 0;
    this.pending_count = 0;
    this.success_count = 0;
    
    this.query_list_link = null;
    this.nowplaying_query_button = null;
    
    this.build();
};
Playdar.StatusBar.prototype = {
    build: function () {
        /* Status bar
           ---------- */
        var status_bar = document.createElement("div");
        status_bar.style.position = 'fixed';
        status_bar.style.bottom = 0;
        status_bar.style.left = 0;
        status_bar.style.zIndex = 100;
        status_bar.style.width = '100%';
        status_bar.style.height = '36px';
        status_bar.style.padding = '7px 0';
        status_bar.style.borderTop = '2px solid #4c7a0f';
        status_bar.style.font = 'normal 13px/18px "Calibri", "Lucida Grande", sans-serif';
        status_bar.style.color = "#335507";
        status_bar.style.background = '#e8f9bb';
        
        /* Left column
           ----------- */
        var left_col = document.createElement("div");
        left_col.style.padding = "0 7px";
        // Logo
        var logo = '<img src="' + Playdar.STATIC_HOST + '/static/playdar_logo_32x32.png" width="32" height="32" style="vertical-align: middle; float: left; margin: 0 10px 0 0; border: 0; line-height: 36px;" />';
        left_col.innerHTML = logo;
        
        // - Status message
        this.status = document.createElement("p");
        this.status.style.margin = "0";
        this.status.style.padding = "0 8px";
        this.status.style.lineHeight = "36px";
        this.status.style.fontSize = "15px";
        left_col.appendChild(this.status);
        
        // - Playback
        this.playback = document.createElement("div");
        this.playback.style.padding = "0 7px";
        this.playback.style.display = "none";
        // - Now playing track
        var track_title = document.createElement("p");
        track_title.style.margin = "0";
        this.track_link = document.createElement("a");
        this.track_link.style.textDecoration = "none";
        
        this.artist_name = document.createElement("span");
        this.artist_name.style.textTransform = "uppercase";
        this.artist_name.style.color = "#4c7a0f";
        
        this.track_name = document.createElement("strong");
        this.track_name.style.margin = "0 0 0 10px";
        this.track_name.style.color = "#335507";
        
        this.track_link.appendChild(this.artist_name);
        this.track_link.appendChild(this.track_name);
        track_title.appendChild(this.track_link);
        this.playback.appendChild(track_title);
        
        // Playback Progress table
        var progress_table = document.createElement("table");
        progress_table.setAttribute('cellpadding', 0);
        progress_table.setAttribute('cellspacing', 0);
        progress_table.setAttribute('border', 0);
        progress_table.style.color = "#4c7a0f";
        progress_table.style.font = 'normal 10px/16px "Verdana", sans-serif';
        var progress_tbody = document.createElement("tbody");
        var progress_row = document.createElement("tr");
        // L: - Time elapsed
        this.track_elapsed = document.createElement("td");
        this.track_elapsed.style.verticalAlign = "middle";
        progress_row.appendChild(this.track_elapsed);
        // M: Bar column
        var progress_cell = document.createElement("td");
        progress_cell.style.padding = "0 5px";
        progress_cell.style.verticalAlign = "middle";
        // Bar container
        var progress_bar = document.createElement("div");
        progress_bar.style.width = this.progress_bar_width + "px";
        progress_bar.style.height = "9px";
        progress_bar.style.border = "1px solid #4c7a0f";
        progress_bar.style.background = "#fff";
        progress_bar.style.position = "relative";
        // - Buffer progress
        this.bufferhead = document.createElement("div");
        this.bufferhead.style.position = "absolute";
        this.bufferhead.style.width = 0;
        this.bufferhead.style.height = "9px";
        this.bufferhead.style.background = "#d2f380";
        progress_bar.appendChild(this.bufferhead);
        // - Playback progress
        this.playhead = document.createElement("div");
        this.playhead.style.position = "absolute";
        this.playhead.style.width = 0;
        this.playhead.style.height = "9px";
        this.playhead.style.background = "#6ea31e";
        progress_bar.appendChild(this.playhead);
        // Click to toggle pause
        progress_bar.onclick = function () {
            Playdar.player.toggle_nowplaying();
        };
        progress_cell.appendChild(progress_bar);
        progress_row.appendChild(progress_cell);
        // R: - Track duration
        this.track_duration = document.createElement("td");
        this.track_duration.style.verticalAlign = "middle";
        progress_row.appendChild(this.track_duration);
        
        progress_tbody.appendChild(progress_row);
        progress_table.appendChild(progress_tbody);
        this.playback.appendChild(progress_table);
        
        left_col.appendChild(this.playback);
        
        /* Right column
           ------------ */
        var right_col = document.createElement("div");
        right_col.style.cssFloat = "right";
        right_col.style.padding = "0 8px";
        right_col.style.textAlign = "right";
        // Settings link
        var settings_link = document.createElement("p");
        settings_link.style.margin = 0;
        settings_link.innerHTML = '<a href="' + Playdar.client.get_base_url() + '" target="_blank">Settings</a>';
        right_col.appendChild(settings_link);
        // - Disconnect link
        this.playdar_links = document.createElement("p");
        this.playdar_links.style.margin = 0;
        
        this.playdar_links.innerHTML = Playdar.client.get_disconnect_link_html();
        right_col.appendChild(this.playdar_links);
        
        // - Query count
        this.query_count = document.createElement("span");
        this.query_count.style.margin = "0 5px 0 5px";
        this.query_count.style.fontSize = "11px";
        this.query_count.style.fontWeight = "normal";
        this.query_count.style.color = "#6ea31e";
        this.playdar_links.insertBefore(this.query_count, this.playdar_links.firstChild);
        
        /* Build status bar
           --------------- */
        status_bar.appendChild(right_col);
        status_bar.appendChild(left_col);
        
        /* Build status bar */
        document.body.appendChild(status_bar);
        
        // Adjust the page bottom margin to fit status bar
        var marginBottom = document.body.style.marginBottom;
        if (!marginBottom) {
            var css = document.defaultView.getComputedStyle(document.body, null);
            if (css) {
                marginBottom = css.marginBottom;
            }
        }
        document.body.style.marginBottom = (marginBottom.replace('px', '') - 0) + 36 + (7*2) + 2 + 'px';
        
        return status_bar;
    },
    
    ready: function () {
        this.playdar_links.style.display = "";
        var message = "Ready";
        this.status.innerHTML = message;
    },
    offline: function () {
        this.playdar_links.style.display = "none";
        var message = Playdar.client.get_auth_link_html();
        this.status.innerHTML = message;
    },
    start_manual_auth: function () {
        this.playdar_links.style.display = "none";
        var input_id = "manualAuth_" + Playdar.client.uuid;
        var form = '<form>'
            + '<input type="text" id="' + input_id + '" />'
            + ' <input type="submit" value="Allow access to Playdar"'
                + ' onclick="Playdar.client.manual_auth_callback(\'' + input_id + '\'); return false;'
            + '" />'
            + '</form>';
        this.status.innerHTML = form;
        Playdar.Util.select('#' + input_id)[0].focus();
    },
    
    handle_stat: function (response) {
        if (response.authenticated) {
            this.ready();
        } else {
            this.offline();
        }
    },
    
    show_resolution_status: function () {
        if (this.query_count) {
            var status = " ";
            if (this.pending_count) {
                status += this.pending_count + ' <img src="' + Playdar.STATIC_HOST + '/static/track_throbber.gif" width="16" height="16" style="vertical-align: middle; margin: -2px 2px 0 2px"/> ';
            }
            status += " " + this.success_count + "/" + this.request_count;
            this.query_count.innerHTML = status;
        }
    },
    handle_results: function (response, final_answer) {
        if (final_answer) {
            this.pending_count--;
            if (response.results.length) {
                this.success_count++;
            }
        }
        this.show_resolution_status();
    },
    increment_requests: function () {
        this.request_count++;
        this.pending_count++;
        this.show_resolution_status();
    },
    cancel_resolve: function () {
        this.pending_count = 0;
        this.show_resolution_status();
    },
    
    get_sound_callbacks: function (result) {
        return {
            whileplaying: function () {
                Playdar.status_bar.playing_handler(this);
            },
            whileloading: function () {
                Playdar.status_bar.loading_handler(this);
            }
        };
    },
    
    play_handler: function (stream) {
        // Initialise the track progress
        this.track_elapsed.innerHTML = Playdar.Util.mmss(0);
        // Update the track link
        this.track_link.href = Playdar.client.get_stream_url(stream.sid);
        this.track_link.title = stream.source;
        this.track_name.innerHTML = stream.track;
        this.artist_name.innerHTML = stream.artist;
        // Update the track duration
        this.track_duration.innerHTML = Playdar.Util.mmss(stream.duration);
        // Show progress bar
        this.status.style.display = "none";
        this.playback.style.display = "";
    },
    playing_handler: function (sound) {
        // Update the track progress
        this.track_elapsed.innerHTML = Playdar.Util.mmss(Math.round(sound.position/1000));
        // Update the playback progress bar
        var duration;
        if (sound.readyState == 3) { // loaded/success
            duration = sound.duration;
        } else {
            duration = sound.durationEstimate;
        }
        var portion_played = sound.position / duration;
        this.playhead.style.width = Math.round(portion_played * this.progress_bar_width) + "px";
        // Call the loading handler too because the sound may have fully loaded while
        // we were playing a different track
        this.loading_handler(sound);
    },
    loading_handler: function (sound) {
        // Update the loading progress bar
        var buffered = sound.bytesLoaded/sound.bytesTotal;
        this.bufferhead.style.width = Math.round(buffered * this.progress_bar_width) + "px";
    },
    stop_current: function () {
        this.playback.style.display = "none";
        this.status.style.display = "";
        
        this.track_link.href = "#";
        this.track_link.title = "";
        this.track_name.innerHTML = "";
        this.artist_name.innerHTML = "";
        
        this.bufferhead.style.width = 0;
        this.playhead.style.width = 0;
    }
};

Playdar.Util = {
    /**
     * Based on: Math.uuid.js
     * Copyright (c) 2008, Robert Kieffer. All rights reserved.
     * License and info: http://www.broofa.com/blog/2008/09/javascript-uuid-function/
    **/
    generate_uuid: function () {
        // Private array of chars to use
        var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
        var uuid = [];
        var rnd = Math.random;
        
        // rfc4122, version 4 form
        var r;
        
        // rfc4122 requires these characters
        uuid[8] = uuid[13] = uuid[18] = uuid[23] = '-';
        uuid[14] = '4';
        
        // Fill in random data.  At i==19 set the high bits of clock sequence as
        // per rfc4122, sec. 4.1.5
        for (var i = 0; i < 36; i++) {
            if (!uuid[i]) {
                r = 0 | rnd()*16;
                uuid[i] = chars[(i == 19) ? (r & 0x3) | 0x8 : r & 0xf];
            }
        }
        return uuid.join('');
    },
    
    // Query string helpers
    toQueryPair: function (key, value) {
        if (value === null) {
            return key;
        }
        return key + '=' + encodeURIComponent(value);
    },
    toQueryString: function (params) {
        var results = [];
        for (var key in params) {
            var values = params[key];
            key = encodeURIComponent(key);
            
            if (Object.prototype.toString.call(values) == '[object Array]') {
                for (var i = 0; i < values.length; i++) {
                    results.push(Playdar.Util.toQueryPair(key, values[i]));
                }
            } else {
                results.push(Playdar.Util.toQueryPair(key, values));
            }
        }
        return results.join('&');
    },
    
    // format secs -> mm:ss helper.
    mmss: function (secs) {
        var s = secs % 60;
        if (s < 10) {
            s = "0" + s;
        }
        return Math.floor(secs/60) + ":" + s;
    },
    
    // JSON loader
    loadjs: function (url) {
       var s = document.createElement("script");
       s.src = url;
       document.getElementsByTagName("head")[0].appendChild(s);
    },
    
    // Cookie helpers
    setcookie: function (name, value, days) {
        var expires;
        if (days) {
            var date = new Date();
            date.setTime(date.getTime() + (days*24*60*60*1000));
            expires = "; expires=" + date.toGMTString();
        } else {
            expires = "";
        }
        document.cookie = name + "=" + value + expires + "; path=/";
    },
    getcookie: function (name) {
        var namekey = name + "=";
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length;i++) {
            var c = cookies[i];
            while (c.charAt(0) == ' ') {
                c = c.substring(1, c.length);
            }
            if (c.indexOf(namekey) === 0) {
                return c.substring(namekey.length, c.length);
            }
        }
        return null;
    },
    deletecookie: function (name) {
        Playdar.Util.setcookie(name, "", -1);
    },
    
    // Window dimension/position helpers
    get_window_position: function () {
        var location = {};
        if (window.screenLeft) {
            location.x = window.screenLeft || 0;
            location.y = window.screenTop || 0;
        } else {
            location.x = window.screenX || 0;
            location.y = window.screenY || 0;
        }
        return location;
    },
    get_window_size: function () {
        return {
            'w': (window && window.innerWidth) || 
                 (document && document.documentElement && document.documentElement.clientWidth) || 
                 (document && document.body && document.body.clientWidth) || 
                 0,
            'h': (window && window.innerHeight) || 
                 (document && document.documentElement && document.documentElement.clientHeight) || 
                 (document && document.body && document.body.clientHeight) || 
                 0
        };
    },
    
    get_popup_options: function (size) {
        var popup_location = Playdar.Util.get_popup_location(size);
        return [
            "left=" + popup_location.x,
            "top=" + popup_location.y,
            "width=" + size.w,
            "height=" + size.h,
            "location=yes",
            "toolbar=no",
            "menubar=yes",
            "status=yes",
            "resizable=yes",
            "scrollbars=yes"
        ].join(',');
    },
    get_popup_location: function (size) {
        var window_location = Playdar.Util.get_window_position();
        var window_size = Playdar.Util.get_window_size();
        return {
            'x': Math.max(0, window_location.x + (window_size.w - size.w) / 2),
            'y': Math.max(0, window_location.y + (window_size.h - size.h) / 2)
        };
    },
    
    // http://ejohn.org/blog/flexible-javascript-events
    addEvent: function (obj, type, fn) {
        if (obj.attachEvent) {
            obj['e'+type+fn] = fn;
            obj[type+fn] = function () {
                obj['e'+type+fn](window.event);
            };
            obj.attachEvent('on'+type, obj[type+fn]);
        } else {
            obj.addEventListener(type, fn, false);
        }
    },
    // Event target helper
    getTarget: function (e) {
        e = e || window.event;
        return e.target || e.srcElement;
    },
    
    extend_object: function (destination, source) {
        source = source || {};
        for (var property in source) {
            destination[property] = source[property];
        }
        return destination;
    },
    
    merge_callback_options: function (callback_options) {
        var option_map = {};
        var keys = [];
        var i, options, option_name;
        // Loop through an array of option objects
        for (i = 0; i < callback_options.length; i++) {
            options = callback_options[i];
            // Process callback functions in each object
            for (option_name in options) {
                if (typeof (options[option_name]) == 'function') {
                    // Collect all matching option callbacks into one callback
                    if (!option_map[option_name]) {
                        keys.push(option_name);
                        option_map[option_name] = [];
                    }
                    option_map[option_name].push(options);
                }
            }
        }
        var final_options = {};
        // Merge the mapped callback options
        for (i = 0; i < keys.length; i++) {
            var key = keys[i];
            // Pass in the scope because closures don't really work
            // with shared variables in a loop
            final_options[key] = (function (key, mapped_options) {
                return function () {
                    // Call each function that's been mapped to this property
                    for (var j = 0; j < mapped_options.length; j++) {
                        mapped_options[j][key].apply(this, arguments);
                    }
                };
            })(key, option_map[key]);
        }
        return final_options;
    },
    
    location_from_url: function (url) {
        // Create a dummy link to split out the url parts
        var dummy = document.createElement('a');
        dummy.href = url;
        var location = {};
        // Use the window.location to extract the location keys
        for (k in window.location) {
            if ((typeof(window.location[k]) === 'string')) {
                location[k] = dummy[k];
            }
        }
        return location;
    },
    
    log: function (response) {
        if (typeof console != 'undefined') {
            console.dir(response);
        }
    },
    null_callback: function () {}
};

// CONTENT PARSING

Playdar.Parse = {
    getProperty: function (collection, prop) {
        var prop = prop || 'innerHTML';
        var i, coll, property;
        for (i = 0; i < collection.length; i++) {
            coll = collection[i];
            property = coll[prop] || coll.getAttribute(prop);
            if (property) {
                return property;
            }
        }
        return;
    },
    getValue: function (collection) {
        var i, coll, value;
        for (i = 0; i < collection.length; i++) {
            coll = collection[i];
            value = Playdar.Util.select('.value', coll);
            if (value.length) {
                return Playdar.Parse.getContentWithoutValue(value);
            }
        }
        return;
    },
    getContentWithoutValue: function (collection) {
        return Playdar.Parse.getProperty(collection, 'content')
            || Playdar.Parse.getProperty(collection, 'title')
            || Playdar.Parse.getProperty(collection);
    },
    getContent: function (collection) {
        var content = Playdar.Parse.getValue(collection)
                   || Playdar.Parse.getContentWithoutValue(collection);
        if (content) {
            return content.replace(/(^\s*)|(\s*$)/g, '');
        }
        return;
    },
    getPosition: function (trackNode) {
        // Extract position from ordered list
        var currentNode = trackNode;
        var elderSiblings = 0;
        if (trackNode.nodeName == 'LI' && trackNode.parentNode.nodeName == 'OL') {
            // Loop back through siblings and count how many come before
            while (currentNode.previousSibling) {
                currentNode = currentNode.previousSibling;
                if (currentNode.nodeName == 'LI') {
                    elderSiblings++;
                }
            }
            return elderSiblings + 1;
        }
        return;
    },
    getNS: function (node, url) {
        for (var i = 0; i < node.attributes.length; i++) {
            var attr = node.attributes[i];
            if (attr.nodeValue == url) {
                return attr.nodeName.replace('xmlns:', '');
            }
        }
    },
    /**
     * Playdar.Parse.getExc(exclude, selector)
     * - exclude (String): CSS selector to exclude results from
     * - selector (String): CSS selector we're looking for
     * 
     * Get a pseudo-selector part that excludes from a selector any results
     * contained within the exclude selector
    **/
    getExc: function (exclude, selector) {
        return ':not(' + exclude + ' ' + selector + ')';
    },
    
    microformats: function (context) {
        var sel = Playdar.Util.select;
        function selExcRec (selector, context) {
            return sel(selector + Playdar.Parse.getExc('.item', selector), context);
        }
        
        function getBuyData (context, rec) {
            var buySel = rec ? sel : selExcRec;
            var buyURL = Playdar.Parse.getProperty(buySel('.payment', context), 'href')
                      || Playdar.Parse.getProperty(buySel('[rel~=payment]', context), 'href');
            if (!buyURL) {
                return;
            }
            return {
                url: buyURL,
                currency: Playdar.Parse.getContent(buySel('.price .currency', context)),
                amount: Playdar.Parse.getContent(buySel('.price .amount', context))
            };
        }
        function getTrackData (tracks, artist, album) {
            var data = [];
            var i, track;
            for (i = 0; i < tracks.length; i++) {
                if (!tracks[i].playdarParsed) {
                    track = {
                        title: Playdar.Parse.getContent(sel('.fn', tracks[i]))
                            || Playdar.Parse.getContent(sel('.title', tracks[i])),
                        artist: Playdar.Parse.getContent(sel('.contributor', tracks[i]))
                             || artist,
                        album: album,
                        position: Playdar.Parse.getContent(sel('.position', tracks[i]))
                               || Playdar.Parse.getPosition(tracks[i]),
                        duration: Playdar.Parse.getContent(sel('.duration', tracks[i])),
                        buy: getBuyData(tracks[i], true),
                        element: tracks[i]
                    };
                    data.push(track);
                    tracks[i].playdarParsed = true;
                }
            }
            return data;
        }
        
        function getArtist (context) {
            // Check the .contributor property for .fn or innerHTML
            var artist = selExcRec('.contributor', context);
            var artistName = Playdar.Parse.getContent(sel('.fn', artist[0]));
            if (!artistName) {
                artistName = Playdar.Parse.getContent(artist);
            }
            return artistName;
        }
        
        function getAlbums (context) {
            var data = [];
            var albums = sel('.haudio', context);
            var i, album_name, album_artist, album_tracks, album, item_artist, item_track, tracks;
            for (i = 0; i < albums.length; i++) {
                if (!albums[i].playdarParsed) {
                    albums[i].playdarParsed = true;
                    album_name = Playdar.Parse.getContent(selExcRec('.album', albums[i]));
                    if (!album_name) {
                        continue;
                    }
                    album_artist = getArtist(albums[i]);
                    if (!album_artist) {
                        continue;
                    }
                    album_tracks = getTrackData(sel('.item', albums[i]), album_artist, album_name);
                    if (!album_tracks.length) {
                        continue;
                    }
                    data.push({
                        type: 'album',
                        title: album_name,
                        artist: album_artist,
                        tracks: album_tracks,
                        image: Playdar.Parse.getProperty(selExcRec('.photo', albums[i]), 'src')
                            || Playdar.Parse.getProperty(selExcRec('.photo', albums[i]), 'href'),
                        download: Playdar.Parse.getProperty(selExcRec('[rel~=enclosure]', albums[i]), 'href'),
                        released: Playdar.Parse.getContent(selExcRec('.published', albums[i])),
                        duration: Playdar.Parse.getContent(selExcRec('.duration', albums[i])),
                        buy: getBuyData(albums[i])
                    });
                }
            }
            return data;
        }
        
        function getTrackLists (context) {
            var lists = getAlbums(context);
            var tracks = getTrackData(sel('.haudio'));
            if (tracks.length) {
                lists.push({
                    type: 'page',
                    title: window.document.title || window.location.href,
                    tracks: tracks
                });
            }
            return lists;
        }
        
        var lists = getTrackLists(context);
        return lists;
    },
    
    rdfa: function (context) {
        var sel = Playdar.Util.select;
        
        var htmlNode = sel('html')[0];
        var commerceNS = Playdar.Parse.getNS(htmlNode, 'http://purl.org/commerce#');
        var audioNS = Playdar.Parse.getNS(htmlNode, 'http://purl.org/media/audio#');
        var mediaNS = Playdar.Parse.getNS(htmlNode, 'http://purl.org/media#');
        var dcNS = Playdar.Parse.getNS(htmlNode, 'http://purl.org/dc/terms/')
                || Playdar.Parse.getNS(htmlNode, 'http://purl.org/dc/elements/1.1/');
        
        var foafNS = Playdar.Parse.getNS(htmlNode, 'http://xmlns.com/foaf/0.1/');
        var moNS = Playdar.Parse.getNS(htmlNode, 'http://purl.org/ontology/mo/');
        
        function selExcRec (selector, context) {
            var final_selector = selector;
            if (audioNS) {
                final_selector += Playdar.Parse.getExc('[typeof='+audioNS+':Recording]', selector);
            }
            if (moNS) {
                final_selector += Playdar.Parse.getExc('[typeof='+moNS+':Track]', selector);
            }
            return sel(final_selector, context);
        }
        
        if (!audioNS && !moNS) {
            
        }
        
        function getBuyData (context, rec) {
            var buySel = rec ? sel : selExcRec;
            var buyURL = Playdar.Parse.getProperty(buySel('[rel~='+commerceNS+':payment]', context), 'href');
            if (!buyURL) {
                return;
            }
            return {
                url: buyURL,
                currency: Playdar.Parse.getContent(buySel('[rel~='+commerceNS+':costs] [property='+commerceNS+':currency]', context)),
                amount: Playdar.Parse.getContent(buySel('[rel~='+commerceNS+':costs] [property='+commerceNS+':amount]', context))
            };
        }
        
        function getTracks (context, artist, album) {
            var data = [];
            var selectors = [];
            if (audioNS) {
                selectors.push('[typeof='+audioNS+':Recording]');
            }
            if (moNS) {
                selectors.push('[typeof='+moNS+':Track]');
            }
            var tracks = selExcRec(selectors.join(','), context);
            var i, track;
            for (i = 0; i < tracks.length; i++) {
                if (!tracks[i].playdarParsed) {
                    track = {
                        title: Playdar.Parse.getContent(sel('[property='+dcNS+':title]', tracks[i])),
                        artist: Playdar.Parse.getContent(sel('[property='+dcNS+':creator], [rel~='+foafNS+':maker] [property='+foafNS+':name]', tracks[i]))
                             || artist,
                        album: Playdar.Parse.getContent(sel('[typeof='+moNS+':Record] [property='+dcNS+':title]'))
                            || album,
                        position: Playdar.Parse.getContent(sel('[property='+mediaNS+':position]', tracks[i]))
                               || Playdar.Parse.getPosition(tracks[i]),
                        duration: Playdar.Parse.getContent(sel('[property='+mediaNS+':duration]', tracks[i]))
                               || Playdar.Parse.getContent(sel('[property='+dcNS+':duration]', tracks[i])),
                        buy: getBuyData(tracks[i], true),
                        element: tracks[i]
                    };
                    data.push(track);
                    tracks[i].playdarParsed = true;
                }
            }
            return data;
        }
        
        function getArtist (context) {
            // Check the dc:creator property for foaf:name or innerHTML
            var artist = selExcRec('[property='+dcNS+':creator]', context);
            if (!artist.length) {
                artist = selExcRec('[rel~='+foafNS+':maker]', context);
            }
            var artistName;
            if (artist.length) {
                artistName = Playdar.Parse.getContent(sel('[property='+foafNS+':name]', artist[0]));
            }
            if (!artistName) {
                // Follow a link to a resource that describes the artist
                var artistLink = sel('[rel~='+dcNS+':creator]', context);
                var artistId = Playdar.Parse.getProperty(artistLink, 'resource');
                if (artistId) {
                    var resource = sel('[about='+artistId+']');
                    artistName = Playdar.Parse.getContent(sel('[property='+foafNS+':name]', resource[0]))
                              || Playdar.Parse.getContent(resource);
                }
            }
            if (!artistName) {
                artistName = Playdar.Parse.getContent(artist);
            }
            return artistName;
        }
        
        function getAlbums (context) {
            var data = [];
            var albums = sel('[typeof='+audioNS+':Album], [typeof='+moNS+':Record]', context);
            var i, album, album_name, album_artist, album_tracks;
            for (i = 0; i < albums.length; i++) {
                if (!albums[i].playdarParsed) {
                    albums[i].playdarParsed = true;
                    album_name = Playdar.Parse.getContent(selExcRec('[property='+dcNS+':title]', albums[i]));
                    if (!album_name) {
                        continue;
                    }
                    album_artist = getArtist(albums[i]);
                    if (!album_artist) {
                        continue;
                    }
                    album_tracks = getTracks(albums[i], album_artist, album_name);
                    if (!album_tracks.length) {
                        continue;
                    }
                    data.push({
                        type: 'album',
                        title: album_name,
                        artist: album_artist,
                        tracks: album_tracks,
                        image: Playdar.Parse.getProperty(selExcRec('[rel~='+mediaNS+':depiction]', albums[i]), 'src')
                            || Playdar.Parse.getProperty(selExcRec('[rev~='+mediaNS+':depiction]', albums[i]), 'src'),
                        download: Playdar.Parse.getProperty(selExcRec('[rel~='+mediaNS+':download]', albums[i]), 'href'),
                        released: Playdar.Parse.getContent(selExcRec('[property='+dcNS+':issued]', albums[i]))
                               || Playdar.Parse.getContent(selExcRec('[property='+dcNS+':published]', albums[i]))
                               || Playdar.Parse.getContent(selExcRec('[property='+dcNS+':date]', albums[i])),
                        duration: Playdar.Parse.getContent(selExcRec('[property='+mediaNS+':duration]', albums[i]))
                               || Playdar.Parse.getContent(selExcRec('[property='+dcNS+':duration]', albums[i])),
                        buy: getBuyData(albums[i])
                    });
                }
            }
            return data;
        }
        
        function getTrackLists (context) {
            var lists = getAlbums(context);
            var tracks = getTracks(context);
            if (tracks.length) {
                lists.push({
                    type: 'page',
                    title: window.document.title || window.location.href,
                    tracks: tracks
                });
            }
            return lists;
        }
        
        var lists = getTrackLists(context);
        return lists;
    }
};

Playdar.Util.addEvent(window, 'beforeunload', Playdar.unload);

/*!
 * Sizzle CSS Selector Engine - v1.0
 *  Copyright 2009, The Dojo Foundation
 *  Released under the MIT, BSD, and GPL Licenses.
 *  More information: http://sizzlejs.com/
 */
(function(){

var chunker = /((?:\((?:\([^()]+\)|[^()]+)+\)|\[(?:\[[^[\]]*\]|['"][^'"]*['"]|[^[\]'"]+)+\]|\\.|[^ >+~,(\[\\]+)+|[>+~])(\s*,\s*)?/g,
    done = 0,
    toString = Object.prototype.toString,
    hasDuplicate = false;

var Sizzle = function(selector, context, results, seed) {
    results = results || [];
    var origContext = context = context || document;

    if ( context.nodeType !== 1 && context.nodeType !== 9 ) {
        return [];
    }
    
    if ( !selector || typeof selector !== "string" ) {
        return results;
    }

    var parts = [], m, set, checkSet, check, mode, extra, prune = true, contextXML = isXML(context);
    
    // Reset the position of the chunker regexp (start from head)
    chunker.lastIndex = 0;
    
    while ( (m = chunker.exec(selector)) !== null ) {
        parts.push( m[1] );
        
        if ( m[2] ) {
            extra = RegExp.rightContext;
            break;
        }
    }

    if ( parts.length > 1 && origPOS.exec( selector ) ) {
        if ( parts.length === 2 && Expr.relative[ parts[0] ] ) {
            set = posProcess( parts[0] + parts[1], context );
        } else {
            set = Expr.relative[ parts[0] ] ?
                [ context ] :
                Sizzle( parts.shift(), context );

            while ( parts.length ) {
                selector = parts.shift();

                if ( Expr.relative[ selector ] )
                    selector += parts.shift();

                set = posProcess( selector, set );
            }
        }
    } else {
        // Take a shortcut and set the context if the root selector is an ID
        // (but not if it'll be faster if the inner selector is an ID)
        if ( !seed && parts.length > 1 && context.nodeType === 9 && !contextXML &&
                Expr.match.ID.test(parts[0]) && !Expr.match.ID.test(parts[parts.length - 1]) ) {
            var ret = Sizzle.find( parts.shift(), context, contextXML );
            context = ret.expr ? Sizzle.filter( ret.expr, ret.set )[0] : ret.set[0];
        }

        if ( context ) {
            var ret = seed ?
                { expr: parts.pop(), set: makeArray(seed) } :
                Sizzle.find( parts.pop(), parts.length === 1 && (parts[0] === "~" || parts[0] === "+") && context.parentNode ? context.parentNode : context, contextXML );
            set = ret.expr ? Sizzle.filter( ret.expr, ret.set ) : ret.set;

            if ( parts.length > 0 ) {
                checkSet = makeArray(set);
            } else {
                prune = false;
            }

            while ( parts.length ) {
                var cur = parts.pop(), pop = cur;

                if ( !Expr.relative[ cur ] ) {
                    cur = "";
                } else {
                    pop = parts.pop();
                }

                if ( pop == null ) {
                    pop = context;
                }

                Expr.relative[ cur ]( checkSet, pop, contextXML );
            }
        } else {
            checkSet = parts = [];
        }
    }

    if ( !checkSet ) {
        checkSet = set;
    }

    if ( !checkSet ) {
        throw "Syntax error, unrecognized expression: " + (cur || selector);
    }

    if ( toString.call(checkSet) === "[object Array]" ) {
        if ( !prune ) {
            results.push.apply( results, checkSet );
        } else if ( context && context.nodeType === 1 ) {
            for ( var i = 0; checkSet[i] != null; i++ ) {
                if ( checkSet[i] && (checkSet[i] === true || checkSet[i].nodeType === 1 && contains(context, checkSet[i])) ) {
                    results.push( set[i] );
                }
            }
        } else {
            for ( var i = 0; checkSet[i] != null; i++ ) {
                if ( checkSet[i] && checkSet[i].nodeType === 1 ) {
                    results.push( set[i] );
                }
            }
        }
    } else {
        makeArray( checkSet, results );
    }

    if ( extra ) {
        Sizzle( extra, origContext, results, seed );
        Sizzle.uniqueSort( results );
    }

    return results;
};

Sizzle.uniqueSort = function(results){
    if ( sortOrder ) {
        hasDuplicate = false;
        results.sort(sortOrder);

        if ( hasDuplicate ) {
            for ( var i = 1; i < results.length; i++ ) {
                if ( results[i] === results[i-1] ) {
                    results.splice(i--, 1);
                }
            }
        }
    }
};

Sizzle.matches = function(expr, set){
    return Sizzle(expr, null, null, set);
};

Sizzle.find = function(expr, context, isXML){
    var set, match;

    if ( !expr ) {
        return [];
    }

    for ( var i = 0, l = Expr.order.length; i < l; i++ ) {
        var type = Expr.order[i], match;
        
        if ( (match = Expr.match[ type ].exec( expr )) ) {
            var left = RegExp.leftContext;

            if ( left.substr( left.length - 1 ) !== "\\" ) {
                match[1] = (match[1] || "").replace(/\\/g, "");
                set = Expr.find[ type ]( match, context, isXML );
                if ( set != null ) {
                    expr = expr.replace( Expr.match[ type ], "" );
                    break;
                }
            }
        }
    }

    if ( !set ) {
        set = context.getElementsByTagName("*");
    }

    return {set: set, expr: expr};
};

Sizzle.filter = function(expr, set, inplace, not){
    var old = expr, result = [], curLoop = set, match, anyFound,
        isXMLFilter = set && set[0] && isXML(set[0]);

    while ( expr && set.length ) {
        for ( var type in Expr.filter ) {
            if ( (match = Expr.match[ type ].exec( expr )) != null ) {
                var filter = Expr.filter[ type ], found, item;
                anyFound = false;

                if ( curLoop == result ) {
                    result = [];
                }

                if ( Expr.preFilter[ type ] ) {
                    match = Expr.preFilter[ type ]( match, curLoop, inplace, result, not, isXMLFilter );

                    if ( !match ) {
                        anyFound = found = true;
                    } else if ( match === true ) {
                        continue;
                    }
                }

                if ( match ) {
                    for ( var i = 0; (item = curLoop[i]) != null; i++ ) {
                        if ( item ) {
                            found = filter( item, match, i, curLoop );
                            var pass = not ^ !!found;

                            if ( inplace && found != null ) {
                                if ( pass ) {
                                    anyFound = true;
                                } else {
                                    curLoop[i] = false;
                                }
                            } else if ( pass ) {
                                result.push( item );
                                anyFound = true;
                            }
                        }
                    }
                }

                if ( found !== undefined ) {
                    if ( !inplace ) {
                        curLoop = result;
                    }

                    expr = expr.replace( Expr.match[ type ], "" );

                    if ( !anyFound ) {
                        return [];
                    }

                    break;
                }
            }
        }

        // Improper expression
        if ( expr == old ) {
            if ( anyFound == null ) {
                throw "Syntax error, unrecognized expression: " + expr;
            } else {
                break;
            }
        }

        old = expr;
    }

    return curLoop;
};

var Expr = Sizzle.selectors = {
    order: [ "ID", "NAME", "TAG" ],
    match: {
        ID: /#((?:[\w\u00c0-\uFFFF_-]|\\.)+)/,
        CLASS: /\.((?:[\w\u00c0-\uFFFF_-]|\\.)+)/,
        NAME: /\[name=['"]*((?:[\w\u00c0-\uFFFF_-]|\\.)+)['"]*\]/,
        ATTR: /\[\s*((?:[\w\u00c0-\uFFFF_-]|\\.)+)\s*(?:(\S?=)\s*(['"]*)(.*?)\3|)\s*\]/,
        TAG: /^((?:[\w\u00c0-\uFFFF\*_-]|\\.)+)/,
        CHILD: /:(only|nth|last|first)-child(?:\((even|odd|[\dn+-]*)\))?/,
        POS: /:(nth|eq|gt|lt|first|last|even|odd)(?:\((\d*)\))?(?=[^-]|$)/,
        PSEUDO: /:((?:[\w\u00c0-\uFFFF_-]|\\.)+)(?:\((['"]*)((?:\([^\)]+\)|[^\2\(\)]*)+)\2\))?/
    },
    attrMap: {
        "class": "className",
        "for": "htmlFor"
    },
    attrHandle: {
        href: function(elem){
            return elem.getAttribute("href");
        }
    },
    relative: {
        "+": function(checkSet, part, isXML){
            var isPartStr = typeof part === "string",
                isTag = isPartStr && !(/\W/).test(part),
                isPartStrNotTag = isPartStr && !isTag;

            if ( isTag && !isXML ) {
                part = part.toUpperCase();
            }

            for ( var i = 0, l = checkSet.length, elem; i < l; i++ ) {
                if ( (elem = checkSet[i]) ) {
                    while ( (elem = elem.previousSibling) && elem.nodeType !== 1 ) {}

                    checkSet[i] = isPartStrNotTag || elem && elem.nodeName === part ?
                        elem || false :
                        elem === part;
                }
            }

            if ( isPartStrNotTag ) {
                Sizzle.filter( part, checkSet, true );
            }
        },
        ">": function(checkSet, part, isXML){
            var isPartStr = typeof part === "string";

            if ( isPartStr && !(/\W/).test(part) ) {
                part = isXML ? part : part.toUpperCase();

                for ( var i = 0, l = checkSet.length; i < l; i++ ) {
                    var elem = checkSet[i];
                    if ( elem ) {
                        var parent = elem.parentNode;
                        checkSet[i] = parent.nodeName === part ? parent : false;
                    }
                }
            } else {
                for ( var i = 0, l = checkSet.length; i < l; i++ ) {
                    var elem = checkSet[i];
                    if ( elem ) {
                        checkSet[i] = isPartStr ?
                            elem.parentNode :
                            elem.parentNode === part;
                    }
                }

                if ( isPartStr ) {
                    Sizzle.filter( part, checkSet, true );
                }
            }
        },
        "": function(checkSet, part, isXML){
            var doneName = done++, checkFn = dirCheck;

            if ( !part.match(/\W/) ) {
                var nodeCheck = part = isXML ? part : part.toUpperCase();
                checkFn = dirNodeCheck;
            }

            checkFn("parentNode", part, doneName, checkSet, nodeCheck, isXML);
        },
        "~": function(checkSet, part, isXML){
            var doneName = done++, checkFn = dirCheck;

            if ( typeof part === "string" && !part.match(/\W/) ) {
                var nodeCheck = part = isXML ? part : part.toUpperCase();
                checkFn = dirNodeCheck;
            }

            checkFn("previousSibling", part, doneName, checkSet, nodeCheck, isXML);
        }
    },
    find: {
        ID: function(match, context, isXML){
            if ( typeof context.getElementById !== "undefined" && !isXML ) {
                var m = context.getElementById(match[1]);
                return m ? [m] : [];
            }
        },
        NAME: function(match, context, isXML){
            if ( typeof context.getElementsByName !== "undefined" ) {
                var ret = [], results = context.getElementsByName(match[1]);

                for ( var i = 0, l = results.length; i < l; i++ ) {
                    if ( results[i].getAttribute("name") === match[1] ) {
                        ret.push( results[i] );
                    }
                }

                return ret.length === 0 ? null : ret;
            }
        },
        TAG: function(match, context){
            return context.getElementsByTagName(match[1]);
        }
    },
    preFilter: {
        CLASS: function(match, curLoop, inplace, result, not, isXML){
            match = " " + match[1].replace(/\\/g, "") + " ";

            if ( isXML ) {
                return match;
            }

            for ( var i = 0, elem; (elem = curLoop[i]) != null; i++ ) {
                if ( elem ) {
                    if ( not ^ (elem.className && (" " + elem.className + " ").indexOf(match) >= 0) ) {
                        if ( !inplace )
                            result.push( elem );
                    } else if ( inplace ) {
                        curLoop[i] = false;
                    }
                }
            }

            return false;
        },
        ID: function(match){
            return match[1].replace(/\\/g, "");
        },
        TAG: function(match, curLoop){
            for ( var i = 0; curLoop[i] === false; i++ ){}
            return curLoop[i] && isXML(curLoop[i]) ? match[1] : match[1].toUpperCase();
        },
        CHILD: function(match){
            if ( match[1] == "nth" ) {
                // parse equations like 'even', 'odd', '5', '2n', '3n+2', '4n-1', '-n+6'
                var test = /(-?)(\d*)n((?:\+|-)?\d*)/.exec(
                    match[2] == "even" && "2n" || match[2] == "odd" && "2n+1" ||
                    !(/\D/).test( match[2] ) && "0n+" + match[2] || match[2]);

                // calculate the numbers (first)n+(last) including if they are negative
                match[2] = (test[1] + (test[2] || 1)) - 0;
                match[3] = test[3] - 0;
            }

            // TODO: Move to normal caching system
            match[0] = done++;

            return match;
        },
        ATTR: function(match, curLoop, inplace, result, not, isXML){
            var name = match[1].replace(/\\/g, "");
            
            if ( !isXML && Expr.attrMap[name] ) {
                match[1] = Expr.attrMap[name];
            }

            if ( match[2] === "~=" ) {
                match[4] = " " + match[4] + " ";
            }

            return match;
        },
        PSEUDO: function(match, curLoop, inplace, result, not){
            if ( match[1] === "not" ) {
                // If we're dealing with a complex expression, or a simple one
                if ( match[3].match(chunker).length > 1 || (/^\w/).test(match[3]) ) {
                    match[3] = Sizzle(match[3], null, null, curLoop);
                } else {
                    var ret = Sizzle.filter(match[3], curLoop, inplace, true ^ not);
                    if ( !inplace ) {
                        result.push.apply( result, ret );
                    }
                    return false;
                }
            } else if ( Expr.match.POS.test( match[0] ) || Expr.match.CHILD.test( match[0] ) ) {
                return true;
            }
            
            return match;
        },
        POS: function(match){
            match.unshift( true );
            return match;
        }
    },
    filters: {
        enabled: function(elem){
            return elem.disabled === false && elem.type !== "hidden";
        },
        disabled: function(elem){
            return elem.disabled === true;
        },
        checked: function(elem){
            return elem.checked === true;
        },
        selected: function(elem){
            // Accessing this property makes selected-by-default
            // options in Safari work properly
            elem.parentNode.selectedIndex;
            return elem.selected === true;
        },
        parent: function(elem){
            return !!elem.firstChild;
        },
        empty: function(elem){
            return !elem.firstChild;
        },
        has: function(elem, i, match){
            return !!Sizzle( match[3], elem ).length;
        },
        header: function(elem){
            return (/h\d/i).test( elem.nodeName );
        },
        text: function(elem){
            return "text" === elem.type;
        },
        radio: function(elem){
            return "radio" === elem.type;
        },
        checkbox: function(elem){
            return "checkbox" === elem.type;
        },
        file: function(elem){
            return "file" === elem.type;
        },
        password: function(elem){
            return "password" === elem.type;
        },
        submit: function(elem){
            return "submit" === elem.type;
        },
        image: function(elem){
            return "image" === elem.type;
        },
        reset: function(elem){
            return "reset" === elem.type;
        },
        button: function(elem){
            return "button" === elem.type || elem.nodeName.toUpperCase() === "BUTTON";
        },
        input: function(elem){
            return (/input|select|textarea|button/i).test(elem.nodeName);
        }
    },
    setFilters: {
        first: function(elem, i){
            return i === 0;
        },
        last: function(elem, i, match, array){
            return i === array.length - 1;
        },
        even: function(elem, i){
            return i % 2 === 0;
        },
        odd: function(elem, i){
            return i % 2 === 1;
        },
        lt: function(elem, i, match){
            return i < match[3] - 0;
        },
        gt: function(elem, i, match){
            return i > match[3] - 0;
        },
        nth: function(elem, i, match){
            return match[3] - 0 == i;
        },
        eq: function(elem, i, match){
            return match[3] - 0 == i;
        }
    },
    filter: {
        PSEUDO: function(elem, match, i, array){
            var name = match[1], filter = Expr.filters[ name ];

            if ( filter ) {
                return filter( elem, i, match, array );
            } else if ( name === "contains" ) {
                return (elem.textContent || elem.innerText || "").indexOf(match[3]) >= 0;
            } else if ( name === "not" ) {
                var not = match[3];

                for ( var i = 0, l = not.length; i < l; i++ ) {
                    if ( not[i] === elem ) {
                        return false;
                    }
                }

                return true;
            }
        },
        CHILD: function(elem, match){
            var type = match[1], node = elem;
            switch (type) {
                case 'only':
                case 'first':
                    while (node = node.previousSibling)  {
                        if ( node.nodeType === 1 ) return false;
                    }
                    if ( type == 'first') return true;
                    node = elem;
                case 'last':
                    while (node = node.nextSibling)  {
                        if ( node.nodeType === 1 ) return false;
                    }
                    return true;
                case 'nth':
                    var first = match[2], last = match[3];

                    if ( first == 1 && last == 0 ) {
                        return true;
                    }
                    
                    var doneName = match[0],
                        parent = elem.parentNode;
    
                    if ( parent && (parent.sizcache !== doneName || !elem.nodeIndex) ) {
                        var count = 0;
                        for ( node = parent.firstChild; node; node = node.nextSibling ) {
                            if ( node.nodeType === 1 ) {
                                node.nodeIndex = ++count;
                            }
                        } 
                        parent.sizcache = doneName;
                    }
                    
                    var diff = elem.nodeIndex - last;
                    if ( first == 0 ) {
                        return diff == 0;
                    } else {
                        return ( diff % first == 0 && diff / first >= 0 );
                    }
            }
        },
        ID: function(elem, match){
            return elem.nodeType === 1 && elem.getAttribute("id") === match;
        },
        TAG: function(elem, match){
            return (match === "*" && elem.nodeType === 1) || elem.nodeName === match;
        },
        CLASS: function(elem, match){
            return (" " + (elem.className || elem.getAttribute("class")) + " ")
                .indexOf( match ) > -1;
        },
        ATTR: function(elem, match){
            var name = match[1],
                result = Expr.attrHandle[ name ] ?
                    Expr.attrHandle[ name ]( elem ) :
                    elem[ name ] != null ?
                        elem[ name ] :
                        elem.getAttribute( name ),
                value = result + "",
                type = match[2],
                check = match[4];

            return result == null ?
                type === "!=" :
                type === "=" ?
                value === check :
                type === "*=" ?
                value.indexOf(check) >= 0 :
                type === "~=" ?
                (" " + value + " ").indexOf(check) >= 0 :
                !check ?
                value && result !== false :
                type === "!=" ?
                value != check :
                type === "^=" ?
                value.indexOf(check) === 0 :
                type === "$=" ?
                value.substr(value.length - check.length) === check :
                type === "|=" ?
                value === check || value.substr(0, check.length + 1) === check + "-" :
                false;
        },
        POS: function(elem, match, i, array){
            var name = match[2], filter = Expr.setFilters[ name ];

            if ( filter ) {
                return filter( elem, i, match, array );
            }
        }
    }
};

var origPOS = Expr.match.POS;

for ( var type in Expr.match ) {
    Expr.match[ type ] = new RegExp( Expr.match[ type ].source + (/(?![^\[]*\])(?![^\(]*\))/).source );
}

var makeArray = function(array, results) {
    array = Array.prototype.slice.call( array );

    if ( results ) {
        results.push.apply( results, array );
        return results;
    }
    
    return array;
};

// Perform a simple check to determine if the browser is capable of
// converting a NodeList to an array using builtin methods.
try {
    Array.prototype.slice.call( document.documentElement.childNodes );

// Provide a fallback method if it does not work
} catch(e){
    makeArray = function(array, results) {
        var ret = results || [];

        if ( toString.call(array) === "[object Array]" ) {
            Array.prototype.push.apply( ret, array );
        } else {
            if ( typeof array.length === "number" ) {
                for ( var i = 0, l = array.length; i < l; i++ ) {
                    ret.push( array[i] );
                }
            } else {
                for ( var i = 0; array[i]; i++ ) {
                    ret.push( array[i] );
                }
            }
        }

        return ret;
    };
}

var sortOrder;

if ( document.documentElement.compareDocumentPosition ) {
    sortOrder = function( a, b ) {
        var ret = a.compareDocumentPosition(b) & 4 ? -1 : a === b ? 0 : 1;
        if ( ret === 0 ) {
            hasDuplicate = true;
        }
        return ret;
    };
} else if ( "sourceIndex" in document.documentElement ) {
    sortOrder = function( a, b ) {
        var ret = a.sourceIndex - b.sourceIndex;
        if ( ret === 0 ) {
            hasDuplicate = true;
        }
        return ret;
    };
} else if ( document.createRange ) {
    sortOrder = function( a, b ) {
        var aRange = a.ownerDocument.createRange(), bRange = b.ownerDocument.createRange();
        aRange.selectNode(a);
        aRange.collapse(true);
        bRange.selectNode(b);
        bRange.collapse(true);
        var ret = aRange.compareBoundaryPoints(Range.START_TO_END, bRange);
        if ( ret === 0 ) {
            hasDuplicate = true;
        }
        return ret;
    };
}

// Check to see if the browser returns elements by name when
// querying by getElementById (and provide a workaround)
(function(){
    // We're going to inject a fake input element with a specified name
    var form = document.createElement("div"),
        id = "script" + (new Date).getTime();
    form.innerHTML = "<a name='" + id + "'/>";

    // Inject it into the root element, check its status, and remove it quickly
    var root = document.documentElement;
    root.insertBefore( form, root.firstChild );

    // The workaround has to do additional checks after a getElementById
    // Which slows things down for other browsers (hence the branching)
    if ( !!document.getElementById( id ) ) {
        Expr.find.ID = function(match, context, isXML){
            if ( typeof context.getElementById !== "undefined" && !isXML ) {
                var m = context.getElementById(match[1]);
                return m ? m.id === match[1] || typeof m.getAttributeNode !== "undefined" && m.getAttributeNode("id").nodeValue === match[1] ? [m] : undefined : [];
            }
        };

        Expr.filter.ID = function(elem, match){
            var node = typeof elem.getAttributeNode !== "undefined" && elem.getAttributeNode("id");
            return elem.nodeType === 1 && node && node.nodeValue === match;
        };
    }

    root.removeChild( form );
})();

(function(){
    // Check to see if the browser returns only elements
    // when doing getElementsByTagName("*")

    // Create a fake element
    var div = document.createElement("div");
    div.appendChild( document.createComment("") );

    // Make sure no comments are found
    if ( div.getElementsByTagName("*").length > 0 ) {
        Expr.find.TAG = function(match, context){
            var results = context.getElementsByTagName(match[1]);

            // Filter out possible comments
            if ( match[1] === "*" ) {
                var tmp = [];

                for ( var i = 0; results[i]; i++ ) {
                    if ( results[i].nodeType === 1 ) {
                        tmp.push( results[i] );
                    }
                }

                results = tmp;
            }

            return results;
        };
    }

    // Check to see if an attribute returns normalized href attributes
    div.innerHTML = "<a href='#'></a>";
    if ( div.firstChild && typeof div.firstChild.getAttribute !== "undefined" &&
            div.firstChild.getAttribute("href") !== "#" ) {
        Expr.attrHandle.href = function(elem){
            return elem.getAttribute("href", 2);
        };
    }
})();

if ( document.querySelectorAll ) (function(){
    var oldSizzle = Sizzle, div = document.createElement("div");
    div.innerHTML = "<p class='TEST'></p>";

    // Safari can't handle uppercase or unicode characters when
    // in quirks mode.
    if ( div.querySelectorAll && div.querySelectorAll(".TEST").length === 0 ) {
        return;
    }
    
    Sizzle = function(query, context, extra, seed){
        context = context || document;

        // Only use querySelectorAll on non-XML documents
        // (ID selectors don't work in non-HTML documents)
        if ( !seed && context.nodeType === 9 && !isXML(context) ) {
            try {
                return makeArray( context.querySelectorAll(query), extra );
            } catch(e){}
        }
        
        return oldSizzle(query, context, extra, seed);
    };

    for ( var prop in oldSizzle ) {
        Sizzle[ prop ] = oldSizzle[ prop ];
    }
})();

if ( document.getElementsByClassName && document.documentElement.getElementsByClassName ) (function(){
    var div = document.createElement("div");
    div.innerHTML = "<div class='test e'></div><div class='test'></div>";

    // Opera can't find a second classname (in 9.6)
    if ( div.getElementsByClassName("e").length === 0 )
        return;

    // Safari caches class attributes, doesn't catch changes (in 3.2)
    div.lastChild.className = "e";

    if ( div.getElementsByClassName("e").length === 1 )
        return;

    Expr.order.splice(1, 0, "CLASS");
    Expr.find.CLASS = function(match, context, isXML) {
        if ( typeof context.getElementsByClassName !== "undefined" && !isXML ) {
            return context.getElementsByClassName(match[1]);
        }
    };
})();

function dirNodeCheck( dir, cur, doneName, checkSet, nodeCheck, isXML ) {
    var sibDir = dir == "previousSibling" && !isXML;
    for ( var i = 0, l = checkSet.length; i < l; i++ ) {
        var elem = checkSet[i];
        if ( elem ) {
            if ( sibDir && elem.nodeType === 1 ){
                elem.sizcache = doneName;
                elem.sizset = i;
            }
            elem = elem[dir];
            var match = false;

            while ( elem ) {
                if ( elem.sizcache === doneName ) {
                    match = checkSet[elem.sizset];
                    break;
                }

                if ( elem.nodeType === 1 && !isXML ){
                    elem.sizcache = doneName;
                    elem.sizset = i;
                }

                if ( elem.nodeName === cur ) {
                    match = elem;
                    break;
                }

                elem = elem[dir];
            }

            checkSet[i] = match;
        }
    }
}

function dirCheck( dir, cur, doneName, checkSet, nodeCheck, isXML ) {
    var sibDir = dir == "previousSibling" && !isXML;
    for ( var i = 0, l = checkSet.length; i < l; i++ ) {
        var elem = checkSet[i];
        if ( elem ) {
            if ( sibDir && elem.nodeType === 1 ) {
                elem.sizcache = doneName;
                elem.sizset = i;
            }
            elem = elem[dir];
            var match = false;

            while ( elem ) {
                if ( elem.sizcache === doneName ) {
                    match = checkSet[elem.sizset];
                    break;
                }

                if ( elem.nodeType === 1 ) {
                    if ( !isXML ) {
                        elem.sizcache = doneName;
                        elem.sizset = i;
                    }
                    if ( typeof cur !== "string" ) {
                        if ( elem === cur ) {
                            match = true;
                            break;
                        }

                    } else if ( Sizzle.filter( cur, [elem] ).length > 0 ) {
                        match = elem;
                        break;
                    }
                }

                elem = elem[dir];
            }

            checkSet[i] = match;
        }
    }
}

var contains = document.compareDocumentPosition ?  function(a, b){
    return a.compareDocumentPosition(b) & 16;
} : function(a, b){
    return a !== b && (a.contains ? a.contains(b) : true);
};

var isXML = function(elem){
    return elem.nodeType === 9 && elem.documentElement.nodeName !== "HTML" ||
        !!elem.ownerDocument && elem.ownerDocument.documentElement.nodeName !== "HTML";
};

var posProcess = function(selector, context){
    var tmpSet = [], later = "", match,
        root = context.nodeType ? [context] : context;

    // Position selectors must be done after the filter
    // And so must :not(positional) so we move all PSEUDOs to the end
    while ( (match = Expr.match.PSEUDO.exec( selector )) ) {
        later += match[0];
        selector = selector.replace( Expr.match.PSEUDO, "" );
    }

    selector = Expr.relative[selector] ? selector + "*" : selector;

    for ( var i = 0, l = root.length; i < l; i++ ) {
        Sizzle( selector, root[i], tmpSet );
    }

    return Sizzle.filter( later, tmpSet );
};

// EXPOSE

Playdar.Util.select = Sizzle;

})();
