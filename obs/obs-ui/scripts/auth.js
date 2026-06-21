// Client token handling for the obs server's shared-secret auth (PI_OBS_TOKEN).
// Classic script, loaded first so later scripts can call window.ObsAuth. When no
// token is stored these helpers are no-ops, so an open (token-less) server works
// unchanged. The token rides an Authorization header on fetch and a ?token=
// query on EventSource (which can't set headers); on a 401 we prompt once, store
// it, and reload so every fetch/stream retries with it.
(function () {
    var KEY = "pi_obs_token";
    var prompting = false;

    function getToken() {
        try {
            return (localStorage.getItem(KEY) || "").trim();
        } catch (e) {
            return "";
        }
    }
    function setToken(t) {
        try {
            localStorage.setItem(KEY, (t || "").trim());
        } catch (e) {
            /* storage unavailable */
        }
    }
    function promptForToken() {
        if (prompting) return;
        prompting = true;
        var t = window.prompt(
            "This obs server requires a token. Paste your PI_OBS_TOKEN:",
        );
        if (t) {
            setToken(t);
            window.location.reload();
        } else {
            prompting = false;
        }
    }
    // fetch wrapper that attaches the token and prompts once on a 401.
    function authFetch(path, opts) {
        opts = opts || {};
        var t = getToken();
        if (t) {
            opts.headers = Object.assign({}, opts.headers, {
                authorization: "Bearer " + t,
            });
        }
        return fetch(path, opts).then(function (res) {
            if (res.status === 401) promptForToken();
            return res;
        });
    }
    // Append ?token= (or &token=) for EventSource URLs.
    function streamUrl(path) {
        var t = getToken();
        if (!t) return path;
        return (
            path +
            (path.indexOf("?") >= 0 ? "&" : "?") +
            "token=" +
            encodeURIComponent(t)
        );
    }

    window.ObsAuth = {
        getToken: getToken,
        setToken: setToken,
        promptForToken: promptForToken,
        fetch: authFetch,
        streamUrl: streamUrl,
    };
})();
