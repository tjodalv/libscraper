# libscraper.js

libscraper.js is a modular and flexible web scraping library built for Node.js, designed to simplify the process of extracting data from websites. It leverages Axios for HTTP requests and Cheerio for parsing HTML, allowing users to scrape and store data in various formats like JSON and CSV.

## Features

- Customizable Data Extraction – Define how pagination, item links, and item data should be extracted.
- Supports JSON & CSV Exports – Store scraped data in different formats, but you can always define custom format like XML for example.
- Batch Processing & Throttling – Control request intervals and batch sizes to avoid bans.
- File Downloading Support – Download files from scraped pages and associate them with data.
- Modular Design – Easily extend functionality using callbacks for custom behavior.

## Dependencies

- node.js
- cheerio
- csv-writer
- mime-types

## Installation

```bash
npm install git+ssh://git@github.com:tjodalv/libscraper.git
```

## Usage example

```js
import { createScraper } from 'libscraper';

const myScraper = createScraper({
    dataDirectory: './data/',
    format: 'csv',
    requestInterval: 2000,
})
// Optionally get pagination links that also needs to be scraped
.findPaginationLinks(($page, url) => {
    return $page('.pagination a').map((_, el) => $page(el).attr('href')).get();
})
// Optionally if page contains links to items you want to scrape find and return array of links
.findItemsLinks(($page, url) => {
    return $page('.product a').map((_, el) => $page(el).attr('href')).get();
})
// Extract needed data from  the webpage
.extractItemData(($page, downloadFile) => {
    const imageUrls = $page('.images a').map((_, el) => $page(el).attr('href')).get();

    const images = await Promise.all(imageUrls.map(async (url) => {
        return await downloadFile(url)
    }));

    return {
        title: $page('.product-title').text(),
        price: $page('.price').text(),
        images,
    };
})
.scrape(['https://example.com/products']);
```

## Options

When initializing scraper using `createScraper()` method you can provide configuration object with this options:

- `dataDirectory` (default: `scraped_data`) - Path to a directory, either relative or absolute. If a relative path is provided, it will be resolved based on the directory where the script is executed.
- `filesDirectory` (default: `files`) - This path is always relative to the `dataDirectory` config option, where all downloaded files will be stored.
- `requestInterval` (default: `2000`) - Time in miliseconds between page requests
- `batchSize` (default: `30`): The number of pages to scrape in a single batch. Once this limit is reached, the scraper will pause before continuing to scrape additional pages. This helps avoid overloading the server or your resources.
- `batchInterval` (default: `5000`): The delay, in milliseconds, between each batch of requests. After scraping the number of pages defined in batchSize, the scraper will wait for this amount of time before proceeding with the next batch.
- `format` (default: `json`): The format in which the scraped data will be saved. Can be set to `'json'` or `'csv'`. This option allows you to choose the output format depending on your needs.
- `userAgent`: The user agent string that will be sent in the request headers for each HTTP request. This simulates a browser request and helps avoid being blocked by websites that restrict automated access.

## Methods

### `findPaginationLinks(callback)` (optional)
Defines how pagination links should be extracted from each URL that is being scraped.

**Callback parameters**
- `$page` (`cheerio.CheerioAPI`) - The Cheerio instance of the current page
- `url` (`string`) - URL currently being processed

### `findItemsLinks(callback)` (optional)
Specifies how to find individual item links on a page. For example, when scraping a category page containing multiple products, this option allows you to extract the links to each product's page for further scraping.

**Callback parameters**
- `$page` (`cheerio.CheerioAPI`) - The Cheerio instance of the current page
- `url` (`string`) - URL currently being processed

### `extractItemData(callback)` (required)
Defines how to scrape data from individual item pages.

**Callback Parameters**
- `$page` (`cheerio.CheerioAPI`) – The Cheerio instance of the current page.
- `downloadFile()` (`libscraper.Scraper.downloadFile(url, filename)`) – Function that enables you to download a file. First parameter is required and is URL to file we want to download. Second is optional `filename`. If you do not provide filaname parameter it will be inferred from the URL.
- `url` (`string`) - URL of the page being scraped.

### `scrape(urls)` (required)
Starts the scraping process for the given array of URLs. Typically `urls` parameter is `array` of strings, but you can also provide url as object.

This option allows you to attach static data to the scraped items. For example, if you're scraping URLs for different categories and want to include a category ID with each item from that URL, you can use this feature to add any other static data as well. For instance:

```js
createScraper(options)
    .scrape([
        {
            url: "https://example.com/products/brand/nike",
            static: { brand_id: 1 }
        },
        {
            url: "https://example.com/products/brand/addidas",
            static: { brand_id: 2 }
        }
    ])
```

### `customizeFilename(callback)`
Customize filename before it is saved to disk. Callback should return new filename.

**Callback parameters**
- `filename` (`string`) - filename that is inferred from URL. Base domain and http(s) protocol is ommited. You can further change this string or create your own custom one.
- `url` (`string`) - URL from which items are scraped
- `items` (`Object[]`) - Array of objects containing scraped data

### `registerDataFormatter(formatterName, callback)`
You can register your own custom data formatter to output scrape data into custom file format.

**formatterName** (`string`)

**Callback parameters**
- `filepath` (`string`) - Path where file should be saved
- `data` (`Object[]`) - Array of objects containing scraped data

Example of creating XML formatter to store data into XML format:

```js
import xml2js from 'xml2js';
import path from 'path';
import fs from 'fs';
import { createScraper } from 'libscraper';

createScraper({
    // Define custom formatter
    format: 'xml'
})
// Register custom formatter function that will convert data to XML and store it to disk
.registerDataFormatter('xml', async function (filepath, data) {
    if (! path.extname(filepath)) {
        // If the file path is missing an extension, append proper extension.
        filepath += '.xml';
    }

    try {
        const builder = new xml2js.Builder();
        const xml = builder.buildObject({ data: data });

        await fs.promises.writeFile(filepath, xml, 'utf8');

        // Return filepath
        return filepath;
    }

    return false;
})
.scrape(['https://example.com/products'])
```