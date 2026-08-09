const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

// ============================================================
// XTEINK X4 SETTINGS
// ============================================================

// Number of XKCD wallpapers to create.
const TARGET_COUNT = 750;

// Xteink X4 portrait screen resolution.
const CANVAS_W = 480;
const CANVAS_H = 800;

// Space around the comic.
const MARGIN = 20;

// Ignore extremely wide XKCD comics.
// width / height
//
// 1.0 = only square/tall comics
// 1.5 = moderately wide comics allowed
// 2.0 = fairly wide comics allowed
//
// The Reddit thread mentions changing this to 1.01
// if you want only comics whose height is roughly equal
// to or greater than their width.
const MAX_ASPECT = 1.3;

// Small pause between requests so we don't hammer XKCD.
const REQUEST_DELAY_MS = 150;

const OUTPUT_DIR = path.join(__dirname, "output");

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

function padNumber(number, length = 4) {
    return String(number).padStart(length, "0");
}

// ============================================================
// WRITE A TRUE 24-BIT UNCOMPRESSED BMP
// ============================================================
//
// Sharp is excellent at image processing but BMP output support
// varies depending on its underlying libvips build.
//
// CrossPoint specifically recommends uncompressed 24-bit BMP,
// so we write the final BMP ourselves.
//
// Input:
//   RGB pixel Buffer
//   width
//   height
//
// BMP stores:
//   BGR instead of RGB
//   rows from bottom to top
//   rows padded to multiples of 4 bytes
// ============================================================

function writeBmp24(rgb, width, height, outputPath) {

    const bytesPerPixel = 3;

    const rowSize =
        Math.ceil((width * bytesPerPixel) / 4) * 4;

    const pixelDataSize = rowSize * height;

    const headerSize = 54;

    const fileSize = headerSize + pixelDataSize;

    const bmp = Buffer.alloc(fileSize);

    // --------------------------------------------------------
    // BITMAP FILE HEADER
    // --------------------------------------------------------

    // "BM"
    bmp.write("BM", 0, 2, "ascii");

    bmp.writeUInt32LE(fileSize, 2);

    // Reserved
    bmp.writeUInt16LE(0, 6);
    bmp.writeUInt16LE(0, 8);

    // Pixel data starts after the 54-byte header.
    bmp.writeUInt32LE(headerSize, 10);

    // --------------------------------------------------------
    // DIB HEADER (BITMAPINFOHEADER)
    // --------------------------------------------------------

    bmp.writeUInt32LE(40, 14);

    bmp.writeInt32LE(width, 18);
    bmp.writeInt32LE(height, 22);

    bmp.writeUInt16LE(1, 26);       // color planes
    bmp.writeUInt16LE(24, 28);      // bits per pixel

    bmp.writeUInt32LE(0, 30);       // BI_RGB = no compression
    bmp.writeUInt32LE(pixelDataSize, 34);

    // nominal DPI
    bmp.writeInt32LE(2835, 38);
    bmp.writeInt32LE(2835, 42);

    bmp.writeUInt32LE(0, 46);
    bmp.writeUInt32LE(0, 50);

    // --------------------------------------------------------
    // PIXEL DATA
    // --------------------------------------------------------

    let outputOffset = headerSize;

    for (let y = height - 1; y >= 0; y--) {

        const rowStart = y * width * 3;

        for (let x = 0; x < width; x++) {

            const inputOffset =
                rowStart + x * 3;

            const r = rgb[inputOffset];
            const g = rgb[inputOffset + 1];
            const b = rgb[inputOffset + 2];

            // BMP uses BGR.
            bmp[outputOffset++] = b;
            bmp[outputOffset++] = g;
            bmp[outputOffset++] = r;
        }

        // Pad each BMP row to a multiple of four bytes.
        while (
            (outputOffset - headerSize) % rowSize !== 0
        ) {
            bmp[outputOffset++] = 0;
        }
    }

    fs.writeFileSync(outputPath, bmp);
}

// ============================================================
// GET XKCD INFORMATION
// ============================================================

async function getLatestXkcdNumber() {

    const response = await axios.get(
        "https://xkcd.com/info.0.json",
        {
            headers: {
                "User-Agent":
                    "XKCD-Xteink-X4-Wallpaper-Generator"
            }
        }
    );

    return response.data.num;
}

async function getComicInfo(number) {

    const url =
        `https://xkcd.com/${number}/info.0.json`;

    const response = await axios.get(url, {
        timeout: 15000,

        headers: {
            "User-Agent":
                "XKCD-Xteink-X4-Wallpaper-Generator"
        }
    });

    return response.data;
}

// ============================================================
// DOWNLOAD IMAGE
// ============================================================

async function downloadImage(url) {

    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 30000,

        headers: {
            "User-Agent":
                "XKCD-Xteink-X4-Wallpaper-Generator"
        }
    });

    return Buffer.from(response.data);
}

// ============================================================
// PROCESS ONE COMIC
// ============================================================

async function processComic(comic, index) {

    const imageBuffer =
        await downloadImage(comic.img);

    // --------------------------------------------------------
    // First clean up the original comic.
    // Flatten transparency onto white and trim empty borders.
    // --------------------------------------------------------

    const trimmedBuffer = await sharp(imageBuffer)
        .flatten({
            background: "#ffffff"
        })
        .trim({
            background: "#ffffff",
            threshold: 10
        })
        .png()
        .toBuffer();

    const metadata =
        await sharp(trimmedBuffer).metadata();

    if (!metadata.width || !metadata.height) {
        throw new Error(
            "Unable to determine image dimensions"
        );
    }

    const aspect =
        metadata.width / metadata.height;

    if (aspect > MAX_ASPECT) {

        console.log(
            `Skipping #${comic.num}: too wide ` +
            `(${aspect.toFixed(2)}:1)`
        );

        return false;
    }

    // --------------------------------------------------------
    // Available area inside our margins
    // --------------------------------------------------------

    const availableWidth =
        CANVAS_W - MARGIN * 2;

    const availableHeight =
        CANVAS_H - MARGIN * 2;

    // --------------------------------------------------------
    // Resize the comic ONCE.
    //
    // This produces an image no larger than 440x760 while
    // retaining its original aspect ratio.
    // --------------------------------------------------------

    const resizedComic =
        await sharp(trimmedBuffer)
            .resize({
                width: availableWidth,
                height: availableHeight,
                fit: "inside",
                withoutEnlargement: false
            })
            .grayscale()
            .normalize()
            .png()
            .toBuffer();

    // --------------------------------------------------------
    // Create a completely separate 480x800 white canvas,
    // then place the resized comic in the center.
    //
    // This avoids Sharp's multiple-resize behavior entirely.
    // --------------------------------------------------------

    const {
        data,
        info
    } = await sharp({
        create: {
            width: CANVAS_W,
            height: CANVAS_H,
            channels: 3,
            background: {
                r: 255,
                g: 255,
                b: 255
            }
        }
    })
        .composite([
            {
                input: resizedComic,
                gravity: "center"
            }
        ])
        .removeAlpha()
        .raw()
        .toBuffer({
            resolveWithObject: true
        });

    // --------------------------------------------------------
    // Verify that we're feeding the BMP writer exactly:
    //
    // 480 x 800
    // 3-channel RGB
    // --------------------------------------------------------

    if (
        info.width !== CANVAS_W ||
        info.height !== CANVAS_H ||
        info.channels !== 3
    ) {
        throw new Error(
            `Unexpected final image: ` +
            `${info.width}x${info.height}, ` +
            `${info.channels} channels`
        );
    }

    const filename =
        `xkcd-${padNumber(index)}-` +
        `${comic.num}.bmp`;

    const outputPath =
        path.join(OUTPUT_DIR, filename);

    writeBmp24(
        data,
        CANVAS_W,
        CANVAS_H,
        outputPath
    );

    console.log(
        `✓ ${index}/${TARGET_COUNT} ` +
        `XKCD #${comic.num}: ${comic.title}`
    );

    return true;
}

// ============================================================
// MAIN PROGRAM
// ============================================================

async function main() {

    console.log("");
    console.log("=================================");
    console.log(" XKCD → Xteink X4 Wallpaper Tool ");
    console.log("=================================");
    console.log("");

    fs.mkdirSync(
        OUTPUT_DIR,
        { recursive: true }
    );

    console.log(
        "Finding newest XKCD comic..."
    );

    const latest =
        await getLatestXkcdNumber();

    console.log(
        `Newest XKCD comic: #${latest}`
    );

    // XKCD #404 intentionally doesn't exist.
    const numbers = [];

    for (let i = 1; i <= latest; i++) {

        if (i !== 404) {
            numbers.push(i);
        }
    }

    shuffle(numbers);

    let completed = 0;
    let attempted = 0;

    console.log(
        `Looking for ${TARGET_COUNT} suitable comics...`
    );

    console.log("");

    for (const number of numbers) {

        if (completed >= TARGET_COUNT) {
            break;
        }

        attempted++;

        try {

            const comic =
                await getComicInfo(number);

            const success =
                await processComic(
                    comic,
                    completed + 1
                );

            if (success) {
                completed++;
            }

        } catch (error) {

            console.log(
                `Skipping XKCD #${number}: ` +
                `${error.message}`
            );
        }

        await sleep(REQUEST_DELAY_MS);
    }

    console.log("");
    console.log("=================================");
    console.log(" Finished");
    console.log("=================================");
    console.log("");

    console.log(
        `Created ${completed} wallpapers.`
    );

    console.log(
        `Folder: ${OUTPUT_DIR}`
    );

    console.log("");

    if (completed < TARGET_COUNT) {

        console.log(
            "Not enough comics passed the filters."
        );

        console.log(
            "Increase MAX_ASPECT and run again."
        );
    }
}

main().catch(error => {

    console.error("");
    console.error("Fatal error:");
    console.error(error);

    process.exit(1);
});