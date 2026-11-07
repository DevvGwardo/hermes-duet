// TS 7 resolves side-effect style imports strictly; declare the vite css modules
// (silkscreen weights + the app stylesheet) so tsc -p passes with typescript@7.
declare module '*.css';
