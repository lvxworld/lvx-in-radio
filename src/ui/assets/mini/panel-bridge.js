// Electron's preload provides window.LvxMini. In the browser test page the panel sits in a frame and
// speaks to the page instead, so both show exactly the same panel.
if (!window.LvxMini) {
  const send = command => window.parent.postMessage({ type: 'lvx-mini-action', command }, window.location.origin);
  window.LvxMini = {
    togglePlay: () => send('toggle-play'),
    open: () => send('open'),
    hide: () => send('hide'),
    toTray: () => send('tray'),
    onVisuals: callback => {
      const listener = event => {
        if (event.origin === window.location.origin && event.source === window.parent && event.data?.type === 'lvx-mini-visuals') callback(event.data.visuals);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
    onState: callback => {
      const listener = event => {
        if (event.origin === window.location.origin && event.source === window.parent && event.data?.type === 'lvx-mini-state') callback(event.data.state);
      };
      window.addEventListener('message', listener);
      send('state');
      return () => window.removeEventListener('message', listener);
    },
  };
}
