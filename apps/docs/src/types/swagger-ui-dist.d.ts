/**
 * Minimal typing for the bundled Swagger UI ES build (`swagger-ui-dist`
 * ships no declarations). Only the options the API explorer passes.
 */
declare module 'swagger-ui-dist/swagger-ui-es-bundle.js' {
  export interface SwaggerRequest {
    url: string;
    headers: Record<string, string>;
    [key: string]: unknown;
  }
  export interface SwaggerUIOptions {
    url?: string;
    domNode: HTMLElement;
    deepLinking?: boolean;
    queryConfigEnabled?: boolean;
    tryItOutEnabled?: boolean;
    requestInterceptor?: (request: SwaggerRequest) => SwaggerRequest;
  }
  const SwaggerUIBundle: (options: SwaggerUIOptions) => unknown;
  export default SwaggerUIBundle;
}

declare module 'swagger-ui-dist/swagger-ui.css';
