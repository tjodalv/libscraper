import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { createObjectCsvWriter } from 'csv-writer';
import path from 'path';
import https from 'https';

const defaultOptions = {
    format: 'json',
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    requestInterval: 2000,
    batchSize: 30,
    batchInterval: 5000,
    dataDirectory: path.join(process.cwd(), 'scraped_data'),
    filesDirectory: './files',
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

// Scrapper API
const Scrapper = {
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
        json: async function jsonFormatter(filepath, data) {
            if (data.length === 0) {
                console.log('No file saved, data is empty');
                return false;
            }

            const fsPromise = fs.promises;

            if (! path.extname(filepath)) {
                filepath += '.json';
            }

            try {
                // Convert the data array to a JSON string with indentation
                const jsonString = JSON.stringify(data, null, 4);

                // Write the JSON data to the file
                await fsPromise.writeFile(filepath, jsonString, 'utf8');

                return filepath;
            } catch (error) {
                console.error("Error writing JSON file:", error);
            }

            return false;
        },
        csv: async function csvFormatter(filepath, data) {
            if (data.length === 0) {
                console.log('No file saved, data is empty');
                return false;
            }

            if (! path.extname(filepath)) {
                filepath += '.csv';
            }

            // Get all unique keys to ensure all attributes are included in CSV headers
            const keys = new Set(data.flatMap(obj => Object.keys(obj)));

            try {
                const csvWriter = createObjectCsvWriter({
                    path: filepath,
                    header: Array.from(keys).map(key => ({ id: key, title: key }))
                });

                await csvWriter.writeRecords(data);

                return filepath;
            } catch (error) {
                console.error("Error writing CSV file:", error);
            }

            return false;
        }
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
        return this.config.dataDirectory.startsWith('/')
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
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': this.config.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
            });

            const $page = cheerio.load(response.data);

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

        if (! path.extname(filename)) {
            filename += '.pdf';
        }

        const filePath = path.join(this._getFilesDirectory(), filename);

        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(filePath);

            https.get(url, response => {
                if (response.statusCode !== 200) {
                    fs.unlink(filePath, () => reject(new Error(`Failed to download ${url}, status code: ${response.statusCode}`)));
                    return;
                }

                response.pipe(file);

                file.on('finish', () => {
                    file.close(err => {
                        if (err) {
                            return reject(err);
                        }
                        // Only return the relative path after the file is fully downloaded
                        resolve(path.relative(this.config.dataDirectory, filePath));
                    });
                });
            }).on('error', err => {
                // Delete partially downloaded file and reject promise on error
                fs.unlink(filePath, () => reject(err));
            });
        });
    }
};

export function createScrapper(options = {}) {
    return {
        ...Scrapper,
        config: {...defaultOptions, ...options},
    };
}
