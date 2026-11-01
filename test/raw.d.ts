// Vite's ?raw imports: a file's contents as a string (see page.test.ts).
declare module "*?raw" {
  const text: string;
  export default text;
}
