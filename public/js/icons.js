// icons.js
// Small, hand-authored, dependency-free icon set - the professional
// replacement for emoji across the whole UI (GDD note: "no emoji anywhere,
// ever" - see engine.test.js #19). Every icon is a plain inline <svg>
// string using currentColor for its stroke, so it always inherits
// whatever text color it's dropped into (a badge, a button, a ticker row)
// with zero extra wiring. Loaded as a plain global (`Icons`) before
// player.js/host.js, since this project has no bundler/module system.
(function (global) {
  function svg(inner) {
    return (
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      inner +
      '</svg>'
    );
  }

  var Icons = {
    // lock / unlock - team ticker + host live table "locked in?" indicator
    lock: svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>'),
    unlock: svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path>'),
    // undo - Tech/Capacity undo buttons
    undo: svg('<polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>'),
    // cpu / layers - Tech vs Capacity, used everywhere the two are named
    cpu: svg(
      '<rect x="6" y="6" width="12" height="12" rx="2"></rect><rect x="10" y="10" width="4" height="4"></rect>' +
        '<line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line>' +
        '<line x1="10" y1="20" x2="10" y2="23"></line><line x1="14" y1="20" x2="14" y2="23"></line>' +
        '<line x1="20" y1="10" x2="23" y2="10"></line><line x1="20" y1="14" x2="23" y2="14"></line>' +
        '<line x1="1" y1="10" x2="4" y2="10"></line><line x1="1" y1="14" x2="4" y2="14"></line>'
    ),
    layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 12 12 17 22 12"></polyline><polyline points="2 17 12 22 22 17"></polyline>'),
    // users / grid - Team channel vs All-Teams channel tabs
    users: svg(
      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle>' +
        '<path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>'
    ),
    grid: svg('<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>'),
    // crown - team leader badge (who can post in the All-Teams channel)
    crown: svg('<path d="M4 18 L7 8 L10 13 L12 5 L14 13 L17 8 L20 18 Z"></path><rect x="4" y="18" width="16" height="3" rx="1"></rect>'),
    // star - round-winner celebration + #1 on the leaderboard
    star: svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>'),
    // alert-triangle - destructive confirm modal
    alertTriangle: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0 Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'),
    // bot - BOT badge
    bot: svg(
      '<rect x="4" y="9" width="16" height="10" rx="2"></rect><path d="M12 9V6"></path><circle cx="12" cy="4.5" r="1.5"></circle>' +
        '<circle cx="9" cy="14" r="1"></circle><circle cx="15" cy="14" r="1"></circle><path d="M2 12v3"></path><path d="M22 12v3"></path>'
    ),
    // send - chat send buttons
    send: svg('<line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>'),
    // plus - Buy buttons
    plus: svg('<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>'),
    // dollar / package / target / trending - shock category icons (COST / DEMAND / PRIORITY / MARKET)
    dollar: svg('<line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>'),
    package: svg(
      '<path d="M16.5 9.4 7.55 4.24"></path>' +
        '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16 Z"></path>' +
        '<path d="M3.27 6.96 12 12.01l8.73-5.05"></path><path d="M12 22.08V12"></path>'
    ),
    target: svg('<circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle>'),
    trending: svg('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline>'),
    // clock - round timer label
    clock: svg('<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'),
    // volume / volumeOff - sound mute toggle
    volume: svg(
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
        '<path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>'
    ),
    volumeOff: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>')
  };

  global.Icons = Icons;
})(window);
