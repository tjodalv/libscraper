import { promises as fs} from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';

export async function csvFormatter(filepath, data) {
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

export async function jsonFormatter(filepath, data) {
    if (data.length === 0) {
        console.log('No file saved, data is empty');
        return false;
    }

    if (! path.extname(filepath)) {
        filepath += '.json';
    }

    try {
        // Convert the data array to a JSON string with indentation
        const jsonString = JSON.stringify(data, null, 4);

        // Write the JSON data to the file
        await fs.writeFile(filepath, jsonString, 'utf8');

        return filepath;
    } catch (error) {
        console.error("Error writing JSON file:", error);
    }

    return false;
}