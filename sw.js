// Only job: show the walk reminders the game's reminder server sends, and open the game when one is tapped.
// It keeps no copy of the game, so the page always loads fresh from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(m.title || 'The Long Way Back', {
    body: m.body || 'You have been down a while. Up, and once round the camp.',
    tag: m.tag || 'round', icon: 'art/icon-192.png', badge: 'art/icon-192.png'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    const open = list.find(c => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow('./?round=1');
  }));
});
