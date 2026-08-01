import '@cloudflare/workers-types';

declare module '@cloudflare/workers-types' {
  interface R2ListOptions {
    include?: Array<'httpMetadata' | 'customMetadata'>;
  }
}
