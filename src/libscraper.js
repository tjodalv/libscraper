import fs from 'fs';
import path from 'path';
import https from 'https';
import * as cheerio from 'cheerio';
import { extension as getExtensionFromMimeType } from 'mime-types';
import { csvFormatter, jsonFormatter } from './formatters.js';

const defaultOptions = {
    format: 'json',
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    requestInterval: 2000,
    batchSize: 30,
    batchInterval: 5000,
    dataDirectory: path.join(process.cwd(), 'scraped_data'),
    filesDirectory: './files',
    usePuppeteer: false,
    puppeteer: {
        options: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        waitForElement: null,
    }
};

function isValidURL(url) {
    try {
        new URL(url); // Try to create a URL object from the string
        return true;   // If no error is thrown, it's a valid URL
    } catch (e) {
        return false;  // If an error is thrown, it's not a valid URL
    }
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Scraper API
const Scraper = {
    config: {},

    _paginationLinksFinder: null,

    _itemsLinkFinder: null,

    _itemDataExtractor($page, downloadFile, url) {
        return null;
    },

    _filenameFormatter(filename, url, items) {
        return filename;
    },

    _dataFormatters: {
        json: jsonFormatter,
        csv: csvFormatter,
    },

    _fetched_pages_num: 0,

    async _throttleRequests() {
        if (this._fetched_pages_num === this.config.batchSize) {
            this._fetched_pages_num = 0;
            await delay(this.config.batchInterval);
        } else {
            await delay(this.config.requestInterval);
        }
    },

    _ensureDirectoryExists() {
        const filesDir = this._getFilesDirectory();

        if (! fs.existsSync(filesDir)) {
            fs.mkdirSync(filesDir, { recursive: true });
        }
    },

    _getDataDirectory() {
        return path.isAbsolute(this.config.dataDirectory)
            ? this.config.dataDirectory
            : path.join(process.cwd(), this.config.dataDirectory)
    },

    _getFilesDirectory() {
        return path.join(this._getDataDirectory(), this.config.filesDirectory);
    },

    _getFilenameFromUrl(url) {
        return `items_${url.replace(/https?:\/\//, '').replace(/\W+/g, '_')}`;
    },

    findPaginationLinks(callback) {
        if (typeof callback === 'function') {
            this._paginationLinksFinder = callback;
        }

        return this;
    },

    findItemsLinks(callback) {
        if (typeof callback === 'function') {
            this._itemsLinkFinder = callback;
        }

        return this;
    },

    customizeFilename(callback) {
        if (typeof callback === 'function') {
            this._filenameFormatter = callback;
        }

        return this;
    },

    registerDataFormatter(formatName, callback) {
        if (typeof callback === 'function') {
            this._dataFormatters[formatName] = callback;
        }

        return this;
    },

    getDataFormatter() {
        return this._dataFormatters[this.config.format];
    },

    // Method that needs to extract item data and return it as object of item properties
    extractItemData(callback) {
        if (typeof callback === 'function') {
            this._itemDataExtractor = callback;
        }

        return this;
    },

    async scrape(urls = []) {
        this._ensureDirectoryExists();

        // Get current formatter
        const formatter = this.getDataFormatter();

        if (! formatter) {
            console.error(`Specified formatter '${this.config.format}' not found. Scrapping aborted.`);
            return;
        }

        for (let i=0, len = urls.length; i < len; i++) {
            let url = urls[i];
            let staticData = {};

            if (typeof url === 'object') {
                const objUrl = url;

                if (! isValidURL(objUrl.url)) {
                    continue;
                }

                url = objUrl.url;

                if (typeof objUrl.static === 'object') {
                    staticData = objUrl.static;
                }
            }

            // Scrape items from url and merge each item with staticData
            const items = await this.scrapeUrl(url, staticData);

            // Generate filename and join with data directory to create filepath
            const filename = this._filenameFormatter(this._getFilenameFromUrl(url), url, items);
            const filepath = path.join(this._getDataDirectory(), filename);

            // Send filepath and items to formatter to store data in preffered format
            const savedFilePath = await Promise.resolve(formatter(filepath, items));

            if (savedFilePath) {
                console.log(`Saved: ${path.basename(savedFilePath)}`);
            }
        }

        // Clean up puppeteer browser instances after scraping
        if (this._browserInstance) {
            this._browserInstance.close();
            this._browserInstance = null;
        }
    },

    async scrapeUrl(url, staticData = {}) {
        let urlsToScrape = [url];
        let items = [];

        const $ = await this.fetchPage(url);

        if (! $) {
            console.log(`Cannot fetch page ${url}`);
            return;
        }

        if (this._paginationLinksFinder) {
            // Find pagination links if that function is defined
            urlsToScrape = [
                url,
                ...await Promise.resolve(this._paginationLinksFinder($, url))
            ];
        }

        for (const pageUrl of urlsToScrape) {
            console.log(`Scraping page: ${pageUrl}`);

            let $page;

            if (pageUrl === url) {
                // We do not need to fetch first page again because it is already fetched
                $page = $;
            } else {
                $page = await this.fetchPage(pageUrl);
            }

            if (! $page) {
                console.log(`Cannot fetch page ${pageUrl}`);
                continue;
            }

            if (this._itemsLinkFinder) {
                const itemsLinks = await Promise.resolve(this._itemsLinkFinder($page, url));

                for (const itemUrl of itemsLinks) {
                    // Scrape item page (news, product, article ...)
                    console.log(`Scraping item: ${itemUrl}`);

                    const $itemPage = await this.fetchPage(itemUrl);

                    const itemData = await Promise.resolve(
                        this._itemDataExtractor($itemPage, this.downloadFile.bind(this), itemUrl)
                    );

                    if (itemData) {
                        items.push({...itemData, ...staticData});
                    }

                    await this._throttleRequests();
                }
            } else {
                // In case we do not have find items links function then
                // we want to extract item data from this URL
                const itemData = await Promise.resolve(
                    this._itemDataExtractor($page, this.downloadFile.bind(this), pageUrl)
                );

                if (itemData) {
                    items.push({...itemData, ...staticData});
                }
            }

            await this._throttleRequests();
        }

        return items;
    },

    // Returns cheerio instance with loaded HTML or null if page cannot be fetched
    async fetchPage(url) {
        try {
            const data = this.config.usePuppeteer
                ? await this._getPageWithPuppeteer(url)
                : await this._getPageWithFetch(url);

            if (! data) {
                throw new Error('Failed to fetch data');
            }

            const $page = cheerio.load(data);

            this._fetched_pages_num++;

            return $page;
        } catch (error) {
            console.error(`Error fetching ${url}:`, error.message);
            return null;
        }
    },

    // Download file to config.filesDirectory directory and returns path to file relative to config.dataDirectory.
    // If filename is not provided it will be inffered from url.
    async downloadFile(url, filename = null) {
        if (! url) return;

        if (! filename) {
            filename = path.basename(String(url).split('?')[0]);
        }

        return new Promise((resolve, reject) => {
            https.get(url, response => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download ${url}, status code: ${response.statusCode}`));
                    return;
                }

                if (! path.extname(filename)) {
                    const mimeType = response.headers['content-type'];
                    // Get the file extension based on MIME type
                    const fileExtension = getExtensionFromMimeType(mimeType);

                    if (fileExtension) {
                        filename += `.${fileExtension}`;
                    }
                }

                const filePath = path.join(this._getFilesDirectory(), filename);
                const file = fs.createWriteStream(filePath);

                response.pipe(file);

                file.on('finish', () => {
                    file.close(err => {
                        if (err) {
                            return reject(err);
                        }
                        // Only return the relative path after the file is fully downloaded
                        resolve(path.relative(this._getDataDirectory(), filePath));
                    });
                });
            }).on('error', err => {
                // Error downloading file
                console.error(`Error downloading file: ${url}.`, err);
                reject(err);
            });
        });
    },

    async _getPageWithFetch(url) {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': this.config.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        if (! response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        return await response.text();
    },

    async _getPageWithPuppeteer(url) {
        const browser = await this._getBrowserInstance();

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'load' });

        if (this.config.puppeteer.waitForSelector) {
            await page.waitForSelector(this.config.puppeteer.waitForSelector);
        }

        // Get the page content after JS has been loaded
        const content = await page.content();
        // Close the page
        await page.close();

        return content;
    },

    _browserInstance: null,

    async _getBrowserInstance() {
        if (this._browserInstance) {
            return this._browserInstance;
        }

        try {
            // Dynamically import puppeteer
            const puppeteer = await import('puppeteer');
        
            this._browserInstance = await puppeteer.launch(this.config.puppeteer.options);
    
            return this._browserInstance;
        } catch (err) {
            console.error('Puppeteer is not installed or there was an error loading it:', err.message);
            return null;
        }
    }
};

export function createScraper(options = {}) {
    return {
        ...Scraper,
        config: {...defaultOptions, ...options},
    };
}
