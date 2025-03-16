import type { CheerioAPI } from 'cheerio';

export interface PuppeteerOptions {
    options: {
        headless: boolean;
        args: string[];
    };
    waitForSelector?: string | null;
}

export interface ScraperOptions {
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
    page: CheerioAPI,
    url: string
) => string[] | Promise<string[]>;

export type ItemDataExtractor = (
    page: CheerioAPI,
    downloadFile: (url: string, filename?: string) => Promise<string>,
    url: string,
    appendToUrlQueue: (url: string|Array<string>) => void,
) => any;

export type FilenameFormatter = (
    filename: string,
    url: string,
    items: any[]
) => string;

export interface ScraperAPI {
    findPaginationLinks(callback: LinkFinder): this;
    findItemsLinks(callback: LinkFinder): this;
    customizeFilename(callback: FilenameFormatter): this;
    registerDataFormatter(formatName: string, callback: DataFormatter): this;
    extractItemData(callback: ItemDataExtractor): this;
    scrape(urls: Array<string | { url: string; static?: object }>): Promise<void>;
}

export const defaultOptions: ScraperOptions;

export function createScraper(options?: Partial<ScraperOptions>): ScraperAPI;