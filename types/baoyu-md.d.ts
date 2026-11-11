declare module "baoyu-md" {
  export interface FrontmatterResult {
    frontmatter: Record<string, any>;
    body: string;
  }

  export interface MermaidRenderOptions {
    baseDir: string;
    renderFn?: (code: string, outputPath: string, options?: unknown) => Promise<void>;
    onError?: (error: unknown, block: { code: string }) => void;
  }

  export interface MermaidPreprocessResult {
    markdown: string;
    images: Array<{
      placeholder: string;
      localPath: string;
      originalPath: string;
      cached?: boolean;
    }>;
  }

  export interface RenderMarkdownOptions {
    theme?: string;
    color?: string;
    citeStatus?: boolean;
    defaultTitle?: string;
    keepTitle?: boolean;
    primaryColor?: string;
  }

  export function cleanSummaryText(text: string): string;
  export function extractSummaryFromBody(body: string, length?: number): string;
  export function extractTitleFromMarkdown(markdown: string): string;
  export function parseFrontmatter(markdown: string): FrontmatterResult;
  export function serializeFrontmatter(data: Record<string, unknown>, content?: string): string;
  export function preprocessMermaidInMarkdown(
    body: string,
    options?: MermaidRenderOptions
  ): Promise<MermaidPreprocessResult>;
  export function renderMarkdownDocument(
    markdown: string,
    options?: RenderMarkdownOptions
  ): Promise<{ html: string }>;
  export function replaceMarkdownImagesWithPlaceholders(
    markdown: string,
    prefix?: string
  ): {
    markdown: string;
    images: Array<{ placeholder: string; localPath: string; originalPath: string }>;
  };
  export function resolveColorToken(color?: string, theme?: string): string;
  export function resolveContentImages(
    images: Array<{ placeholder: string; localPath: string; originalPath: string }>,
    baseDir: string,
    tempDir?: string,
    logPrefix?: string
  ): Promise<Array<{ placeholder: string; localPath: string; originalPath: string }>>;
  export function stripWrappingQuotes(str?: unknown): string;
}
