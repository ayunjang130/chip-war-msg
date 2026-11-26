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
    volumeOff: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>'),
    chevronLeft: svg('<polyline points="15 18 9 12 15 6"></polyline>'),
    chevronRight: svg('<polyline points="9 18 15 12 9 6"></polyline>'),
    close: svg('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'),
    bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>'),
    // analyst - a spark, the in-browser assistant's mark
    spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"></path>'),
    download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>'),
    external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>'),
    play: svg('<polygon points="6 4 20 12 6 20 6 4"></polygon>'),
    pause: svg('<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>'),
    skip: svg('<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line>'),
    award: svg('<circle cx="12" cy="8" r="6"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline>'),
    activity: svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>'),
    message: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'),
    plusUser: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line>'),
    logOut: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>'),
    monitor: svg('<rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>'),
    book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>'),
    check: svg('<polyline points="20 6 9 17 4 12"></polyline>')
  };

  // Brand mark: a die viewed from above - pins on four sides, a bond-wire
  // gold core. Filled, not stroked, so it reads at 24px.
  Icons.brand =
    '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">' +
    '<g fill="#e3b341">' +
    [7, 12, 17, 22].map(function (p) {
      return '<rect x="' + p + '" y="1" width="3" height="4" rx=".5"/><rect x="' + p + '" y="27" width="3" height="4" rx=".5"/><rect x="1" y="' + p + '" width="4" height="3" rx=".5"/><rect x="27" y="' + p + '" width="4" height="3" rx=".5"/>';
    }).join('') +
    '</g><rect x="6" y="6" width="20" height="20" rx="2.5" fill="#1b2534" stroke="#e3b341" stroke-width="1.5"/>' +
    '<rect x="11" y="11" width="10" height="10" rx="1" fill="#e3b341"/></svg>';

  global.Icons = Icons;
})(window);
