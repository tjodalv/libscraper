import fs from 'fs';
import path from 'path';
import https from 'https';
import { load as cheerioLoadHtml } from 'cheerio';
import { extension as getExtensionFromMimeType } from 'mime-types';
import { csvFormatter, jsonFormatter } from './formatters.js';

export const defaultOptions = {
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
        }
    }
};

export const createScraper = (options) => ScraperAPI(options);

function deepMerge(target, source) {
    for (const key in source) {
        if (source.hasOwnProperty(key)) {
            if (typeof source[key] === 'object' && source[key] !== null && target[key] !== undefined) {
                // If the value is an object, recursively merge it
                target[key] = deepMerge(target[key], source[key]);
            } else {
                // Otherwise, just assign the value
                target[key] = source[key];
            }
        }
    }
    return target;
}

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

function ScraperAPI(options = {}) {
    const config = deepMerge({ ...defaultOptions }, options);

    // This selectors are used when scraper is using puppeteer for scraping
    const waitForSelectors = {
        paginationFinder: null,
        itemsFinder: null,
        dataExtractor: null,
    };

    // Register default callbacks
    const callbacks = {
        paginationLinksFinder: null,
        itemsLinkFinder: null,
        itemDataExtractor: ($page, downloadFile, url, appendToUrlQueue) => null,
        filenameFormatter: (filename, url, items) => filename,
    };

    // Register default data formatters
    const dataFormatters = {
        json: jsonFormatter,
        csv: csvFormatter,
    };

    let fetched_pages_num = 0;

    async function throttleRequests() {
        if (fetched_pages_num === config.batchSize) {
            fetched_pages_num = 0;
            await delay(config.batchInterval);
        } else {
            await delay(config.requestInterval);
        }
    }

    function getDataDirectory() {
        return path.isAbsolute(config.dataDirectory)
            ? config.dataDirectory
            : path.join(process.cwd(), config.dataDirectory)
    }

    function getFilesDirectory() {
        return path.join(getDataDirectory(), config.filesDirectory);
    }

    function ensureDirectoryExists() {
        const filesDir = getFilesDirectory();

        if (! fs.existsSync(filesDir)) {
            fs.mkdirSync(filesDir, { recursive: true });
        }
    }

    function getFilenameFromUrl(url) {
        return `items_${url.replace(/https?:\/\//, '').replace(/\W+/g, '_')}`;
    }

    function getDataFormatter() {
        return dataFormatters[config.format];
    }

    // Holds puppeteer browser instance during scraping
    let browserInstance = null;

    async function getBrowserInstance() {
        if (browserInstance) {
            return browserInstance;
        }

        let puppeteer;

        try {
            // Dynamically import puppeteer
            puppeteer = await import('puppeteer');
        }
        catch (err) {
            console.warn('Failed to load puppeteer, try loading puppeteer-core.');

            try {
                // Fallback to puppeteer-core
                puppeteer = await import('puppeteer-core');
            } catch (err2) {
                console.error('puppeteer or puppeteer-core are not available. Install missing dependencies.', err2.message);
                return null;
            }
        }

        browserInstance = await puppeteer.launch(config.puppeteer.options);
        return browserInstance;
    }

    async function getPageWithFetch(url) {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': config.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        if (! response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        return await response.text();
    }

    async function getPageWithPuppeteer(url, waitForSelector = null) {
        const browser = await getBrowserInstance();

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'load' });

        if (waitForSelector) {
            await page.waitForSelector(waitForSelector);
        }

        // Get the page content after JS has been loaded
        const content = await page.content();

        await page.close();

        return content;
    }

    // Returns cheerio instance with loaded HTML or null if page cannot be fetched
    async function fetchPage(url, waitForSelector = null) {
        try {
            const data = config.usePuppeteer
                ? await getPageWithPuppeteer(url, waitForSelector)
                : await getPageWithFetch(url);

            if (! data) {
                throw new Error('Failed to fetch data');
            }

            const $page = cheerioLoadHtml(data);

            fetched_pages_num++;

            return $page;
        }
        catch (err) {
            console.error(`Error fetching ${url}:`, err.message);
            return null;
        }
    }

    // Download file to config.filesDirectory directory and returns path to file relative
    // to that data directory. If filename is not provided it will be infered from the url.
    async function downloadFile(url, filename = null) {
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

                const filePath = path.join(getFilesDirectory(), filename);
                const file = fs.createWriteStream(filePath);

                response.pipe(file);

                file.on('finish', () => {
                    file.close(err => {
                        if (err) return reject(err);

                        // Only return the relative path after the file is fully downloaded
                        resolve(path.relative(getDataDirectory(), filePath));
                    });
                });
            }).on('error', err => {
                // Error downloading file
                console.error(`Error downloading file: ${url}.`, err);
                reject(err);
            });
        });
    }

    // This is used by scrapeUrl function to track which URLs has been scraped
    // and to prevent duplicate scraping
    const scrapedUrls = new Set();

    async function scrapeUrl(url, staticData = {}) {
        let urlsToScrape = [url];
        let items = [];
        const parsedUrl = new URL(url);
        const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

        const $ = await fetchPage(url, waitForSelectors.paginationFinder);

        if (! $) {
            console.log(`Cannot fetch page ${url}`);
            return;
        }

        if (callbacks.paginationLinksFinder) {
            // Find pagination links if that function is defined
            urlsToScrape = urlsToScrape.concat(
                await Promise.resolve(callbacks.paginationLinksFinder($, url))
            );
        }

        // Create URL queue
        const urlQueue = {
            list: [...urlsToScrape]
        };

        // Object that holds extra data attached to specified URL
        const dataForUrl = {};

        // Adds new URLs to the queue, ensuring they are valid, not already in the queue
        // and have not been scraped yet.
        const appendUrlToQueue = (queue) => {
            return (url, urlData) => {
                if (Array.isArray(url)) {
                    url.forEach(u => {
                        if (isValidURL(u) && ! scrapedUrls.has(u) && ! queue.list.includes(u)) {
                            queue.list.push(u);

                            if (urlData) {
                                dataForUrl[u] = urlData;
                            }
                        }
                    });
                } else {
                    if (isValidURL(url) && ! scrapedUrls.has(url) && ! queue.list.includes(url)) {
                        queue.list.push(url);

                        if (urlData) {
                            dataForUrl[url] = urlData;
                        }
                    }
                }
            };
        };

        while (urlQueue.list.length > 0) {
            const pageUrl = urlQueue.list.shift();

            if (scrapedUrls.has(pageUrl)) {
                console.log(`URL already scraped. Skipping page: ${pageUrl}`);
                continue;
            }

            const waitForSelector = callbacks.itemsLinkFinder
                ? waitForSelectors.itemsFinder
                : waitForSelectors.dataExtractor;

            console.log(`Scraping page: ${pageUrl}`);

            const $page = (pageUrl === url)
                ? $
                : await fetchPage(pageUrl, waitForSelector);

            // Put scraped page into scrapedUrls set
            scrapedUrls.add(pageUrl);

            if (! $page) {
                console.log(`Cannot fetch page ${pageUrl}`);
                continue;
            }

            if (callbacks.itemsLinkFinder) {
                const itemsLinks = {
                    list: await Promise.resolve(callbacks.itemsLinkFinder($page, url)) || []
                };

                //for (let itemUrl of itemsLinks) {
                while (itemsLinks.list.length > 0) {
                    let itemUrl = itemsLinks.list.shift();

                    // Scrape item page (news, product, article ...)
                    console.log(`Scraping item page: ${itemUrl}`);

                    if (! itemUrl.startsWith('http')) {
                        // If itemUrl is missing full address then append baseUrl to it
                        itemUrl = baseUrl + itemUrl;
                    }

                    const $itemPage = await fetchPage(itemUrl, waitForSelectors.dataExtractor);

                    const extraData = dataForUrl[itemUrl];

                    const itemData = await Promise.resolve(
                        callbacks.itemDataExtractor($itemPage, downloadFile, itemUrl, appendUrlToQueue(itemsLinks), extraData)
                    );

                    if (Array.isArray(itemData)) {
                        items = [
                            ...items,
                            itemData.map(item => ({
                                ...item,
                                ...staticData,
                                ...extraData || {}
                            }))
                        ];
                    } else {
                        if (itemData) {
                            items.push({...itemData, ...staticData, ...extraData || {}});
                        }
                    }

                    await throttleRequests();
                }
            } else {
                const extraData = dataForUrl[pageUrl];

                // In case we do not have find items links function then
                // we want to extract item data from this URL
                const itemData = await Promise.resolve(
                    callbacks.itemDataExtractor($page, downloadFile, pageUrl, appendUrlToQueue(urlQueue), extraData)
                );

                if (Array.isArray(itemData)) {
                    items = [
                        ...items,
                        itemData.map(item => ({
                            ...item,
                            ...staticData,
                            ...extraData || {}
                        }))
                    ];
                } else {
                    if (itemData) {
                        items.push({...itemData, ...staticData, ...extraData || {}});
                    }
                }
            }

            await throttleRequests();
        }

        return items;
    }

    async function scrape(urls = []) {
        ensureDirectoryExists();

        // Get current formatter
        const formatter = getDataFormatter();

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
            const items = await scrapeUrl(url, staticData);

            // Generate filename and join with data directory to create filepath
            const filename = callbacks.filenameFormatter(getFilenameFromUrl(url), url, items);
            const filepath = path.join(getDataDirectory(), filename);

            // Send filepath and items to formatter to store data in preffered format
            const savedFilePath = await Promise.resolve(formatter(filepath, items));

            if (savedFilePath) {
                console.log(`Saved: ${path.basename(savedFilePath)}`);
            }
        }

        // Clean up puppeteer browser instances after scraping
        if (browserInstance) {
            browserInstance.close();
            browserInstance = null;
        }
    }

    // Expose Scraper API
    return {
        extractItemData(callback, options = {}) {
            if (typeof callback === 'function') {
                callbacks.itemDataExtractor = callback;
            }

            if (options.waitForSelector) {
                waitForSelectors.dataExtractor = options.waitForSelector;
            }

            return this;
        },
        registerDataFormatter(formatName, callback) {
            if (typeof callback === 'function') {
                dataFormatters[formatName] = callback;
            }

            return this;
        },
        customizeFilename(callback) {
            if (typeof callback === 'function') {
                callbacks.filenameFormatter = callback;
            }

            return this;
        },
        findItemsLinks(callback, options = {}) {
            if (typeof callback === 'function') {
                callbacks.itemsLinkFinder = callback;
            }

            if (options.waitForSelector) {
                waitForSelectors.itemsFinder = options.waitForSelector;
            }

            return this;
        },
        findPaginationLinks(callback, options = {}) {
            if (typeof callback === 'function') {
                callbacks.paginationLinksFinder = callback;
            }

            if (options.waitForSelector) {
                waitForSelectors.paginationFinder = options.waitForSelector;
            }

            return this;
        },
        scrape,
    };
}