export {};

declare global {
  interface R2ListOptions {
    include?: Array<'httpMetadata' | 'customMetadata'>;
  }
}
