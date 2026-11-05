// The build this client (or server) was made from: Vite defines __BUILD__ (the commit and the
// time it was built); a test run or a bare TypeScript import sees 'dev'.

declare const __BUILD__: string | undefined;

export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
