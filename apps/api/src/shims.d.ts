declare module 'dotenv' {
  const dotenv: { config(options?: Record<string, unknown>): void };
  export default dotenv;
}
