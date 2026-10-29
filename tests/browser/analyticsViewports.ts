// Shared by the responsive assertions and visual captures. Keep both physical-screen
// and browser-chrome heights for the user's ultrawide monitor.
// 2293x840 is the user's measured window: a 3440x1440 screen at 150% scaling, less the
// taskbar and browser bars (fitted from their screenshot at a scale of 0.872).
export const analyticsViewports = [
  { width: 3440, height: 1440, key: '3440x1440', allScreens: true },
  { width: 3440, height: 1300, key: '3440', allScreens: true },
  { width: 2752, height: 1045, key: '2752', allScreens: false },
  { width: 2293, height: 840, key: '2293', allScreens: true },
  { width: 2560, height: 1300, key: '2560', allScreens: false },
  { width: 1920, height: 1080, key: '1920', allScreens: false },
  { width: 1920, height: 950, key: '1920x950', allScreens: false },
  { width: 1680, height: 950, key: '1680', allScreens: false },
  { width: 1440, height: 900, key: '1440', allScreens: true },
  { width: 1366, height: 768, key: '1366', allScreens: false },
  { width: 1280, height: 720, key: '1280', allScreens: false },
  { width: 1024, height: 768, key: '1024', allScreens: false },
  { width: 768, height: 1024, key: '768', allScreens: false },
  { width: 600, height: 900, key: '600', allScreens: false },
  { width: 390, height: 844, key: '390', allScreens: true },
  { width: 320, height: 568, key: '320', allScreens: false },
] as const;
