/* https://gist.github.com/0XDE57/fbd302cef7693e62c769 */
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true); /* Enable userChrome.css */
user_pref("full-screen-api.ignore-widgets", true); /* Works good with WMs */
user_pref("network.cookie.cookieBehavior", 1); /* Only cookies from the originating server */
user_pref("network.http.referer.spoofSource", true); /* Send fake referrer (of choose to send referrers) */
user_pref("privacy.trackingprotection.enabled", true); /* Mozilla's built in tracking protection */
user_pref("geo.enabled", false); /* I don't use this */
user_pref("dom.battery.enabled", false); /* Disable websites reading your battery level */

/* Disable notifications */
user_pref("dom.webnotifications.enabled", false);
user_pref("dom.webnotifications.serviceworker.enabled", false);
user_pref("dom.push.connection.enabled", false);
user_pref("dom.push.enabled", false);

/* Some prefs */
user_pref("browser.search.openintab", true);
user_pref("extensions.pocket.enabled", false);
