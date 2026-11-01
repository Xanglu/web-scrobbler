/**
 * Read ICY metadata from a Radio Garden station stream.
 *
 * This runs in the extension background, because a content script request is
 * subject to CORS once Radio Garden redirects to the station's stream server.
 * Some stream servers reject the resulting preflight request.
 */

const STATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const STREAM_URL = 'https://radio.garden/api/ara/content/listen';
const STREAM_FORMAT = 'channel.mp3';

const REQUEST_TIMEOUT = 20_000;
const MAX_METADATA_INTERVAL = 256 * 1024;
const MAX_STREAM_BYTES = 512 * 1024;
const MAX_METADATA_BLOCKS = 8;

const STREAM_TITLE_PATTERN = /StreamTitle\s*=\s*(['"])(.*?)\1\s*(?:;|$)/s;

/**
 * Fetch the first usable ICY metadata block for a station.
 * @param stationId - Radio Garden station ID
 * @param timeout - Request timeout in milliseconds
 * @returns Raw ICY metadata block or null
 */
export default async function fetchIcyMetadata(
	stationId: string,
	timeout = REQUEST_TIMEOUT,
): Promise<string | null> {
	if (!STATION_ID_PATTERN.test(stationId)) {
		return null;
	}

	const url = `${STREAM_URL}/${encodeURIComponent(
		stationId,
	)}/${STREAM_FORMAT}`;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	try {
		const response = await fetch(url, {
			headers: {
				'Icy-MetaData': '1',
			},
			signal: controller.signal,
			cache: 'no-store',
		});

		if (!response.ok || !response.body) {
			return null;
		}

		const metaint = Number.parseInt(
			response.headers.get('icy-metaint') ?? '',
			10,
		);
		if (
			!Number.isFinite(metaint) ||
			metaint <= 0 ||
			metaint > MAX_METADATA_INTERVAL
		) {
			return null;
		}

		reader = response.body.getReader();

		const chunks: Uint8Array[] = [];
		let received = 0;
		let downloaded = 0;
		let blocks = 0;
		let lastMetadata: string | null = null;

		while (downloaded < MAX_STREAM_BYTES && blocks < MAX_METADATA_BLOCKS) {
			const { value, done } = await reader.read();
			if (done || !value) {
				break;
			}

			chunks.push(value);
			received += value.byteLength;
			downloaded += value.byteLength;

			let buffer = concatChunks(chunks, received);

			while (
				blocks < MAX_METADATA_BLOCKS &&
				buffer.length >= metaint + 1
			) {
				const metadataLength = buffer[metaint] * 16;
				const metadataEnd = metaint + 1 + metadataLength;

				if (buffer.length < metadataEnd) {
					break;
				}

				const metadata = decodeIcyText(
					buffer.subarray(metaint + 1, metadataEnd),
				);
				lastMetadata = metadata;
				blocks++;

				buffer = buffer.subarray(metadataEnd);

				const match = STREAM_TITLE_PATTERN.exec(metadata);
				if (match && match[2].trim()) {
					return metadata;
				}
			}

			// Keep only the unparsed remainder for the next chunk.
			chunks.length = 0;
			chunks.push(buffer);
			received = buffer.length;
		}

		return lastMetadata;
	} catch {
		// Aborted requests, offline streams and network failures are expected.
		return null;
	} finally {
		clearTimeout(timeoutId);

		if (reader) {
			try {
				await reader.cancel();
			} catch {
				// The stream may already be closed.
			}
		}
	}
}

/**
 * Concatenate received chunks into a single buffer.
 * @param chunks - Received chunks
 * @param length - Total length of the chunks
 * @returns Concatenated buffer
 */
function concatChunks(chunks: Uint8Array[], length: number): Uint8Array {
	const buffer = new Uint8Array(length);
	let offset = 0;

	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return buffer;
}

/**
 * Decode an ICY metadata block.
 * @param bytes - Raw metadata bytes, padded with null bytes
 * @returns Decoded metadata
 */
function decodeIcyText(bytes: Uint8Array): string {
	let text = new TextDecoder('utf-8').decode(bytes);

	// Most stations send UTF-8, but some still use a single-byte encoding.
	if (text.includes('\uFFFD')) {
		text = new TextDecoder('windows-1252').decode(bytes);
	}

	return text.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
}
