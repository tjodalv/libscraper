import type { Root as CheerioRoot } from 'cheerio';

export interface PuppeteerOptions {
    options: {
        headless: boolean;
        args: string[];
    };
    waitForSelector?: string | null;
}

export interface ConfigOptions {
    format: string;
    userAgent: string;
    requestInterval: number;
    batchSize: number;
    batchInterval: number;
    dataDirectory: string;
    filesDirectory: string;
    usePuppeteer: boolean;
    puppeteer: PuppeteerOptions;
}

export type DataFormatter = (
    filepath: string,
    items: any[]
) => string | Promise<string>;

export type LinkFinder = (
    page: CheerioRoot,
    url: string
) => string[] | Promise<string[]>;

export type ItemDataExtractor = (
    page: CheerioRoot,
    downloadFile: (url: string, filename?: string) => Promise<string>,
    url: string
) => any;

export type FilenameFormatter = (
    filename: string,
    url: string,
    items: any[]
) => string;

export interface Scraper {
  config: ConfigOptions;
  findPaginationLinks(callback: LinkFinder): this;
  findItemsLinks(callback: LinkFinder): this;
  customizeFilename(callback: FilenameFormatter): this;
  registerDataFormatter(formatName: string, callback: DataFormatter): this;
  getDataFormatter(): DataFormatter;
  extractItemData(callback: ItemDataExtractor): this;
  scrape(urls: Array<string | { url: string; static?: object }>): Promise<void>;
  scrapeUrl(url: string, staticData?: object): Promise<any[]>;
  fetchPage(url: string): Promise<CheerioRoot | null>;
  downloadFile(url: string, filename?: string): Promise<string>;
}

export function createScraper(options?: Partial<ConfigOptions>): Scraper;