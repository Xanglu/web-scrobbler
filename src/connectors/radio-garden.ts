import type { Separator } from '@/core/content/util';

export {};

/**
 * Radio Garden only exposes the station name in its player UI. The song
 * currently playing is sent by the station itself as ICY metadata on the
 * stream, so we periodically sample the beginning of the stream and parse
 * the `StreamTitle` field.
 *
 * Example: https://radio.garden/listen/kcbp-95-5-fm/I5s0MfBS
 */

const PLAYER_SELECTOR = '[data-jest-id="playBar"]';
const PAUSE_BUTTON_SELECTOR = [
	`${PLAYER_SELECTOR} button[aria-label="stop"]`,
	`${PLAYER_SELECTOR} button[aria-label="pause"]`,
];
const STATION_TITLE_SELECTOR = [
	'[data-jest-id^="playBarChannelTitle"]',
	'[role="contentinfo"] [dir="auto"]',
];

const POLL_INTERVAL = 30_000;
const QUICK_POLL_DELAY = 1_000;

/**
 * Number of consecutive polls with unusable metadata after which the previous
 * track is forgotten. This prevents a station from keeping the last song
 * forever when it stops sending `StreamTitle`.
 */
const EMPTY_METADATA_POLLS_BEFORE_RESET = 2;

const SEPARATORS: Separator[] = [' -- ', ' - ', ' – ', ' — ', ' | ', ' • '];

const IGNORED_TITLES = /^(ad|advert|advertisement|jingle|unknown|undefined)$/i;

interface IcyTrack {
	artist: string;
	track: string;
}

let currentStationId: string | null = null;
let icyTrack: IcyTrack | null = null;
let icyRawTitle: string | null = null;
let emptyMetadataPolls = 0;
let pollTimer: number | null = null;
let quickPollTimer: number | null = null;
let isFetching = false;
let isStarted = false;

Connector.playerSelector = PLAYER_SELECTOR;
Connector.pauseButtonSelector = PAUSE_BUTTON_SELECTOR;

const filter = MetadataFilter.createFilter({
	track: [
		MetadataFilter.removeRemastered,
		MetadataFilter.removeVersion,
		MetadataFilter.removeLive,
	],
});

Connector.applyFilter(filter);

Connector.getArtist = () => icyTrack?.artist ?? null;
Connector.getTrack = () => icyTrack?.track ?? null;

Connector.getUniqueID = () => {
	if (!currentStationId || !icyRawTitle) {
		return null;
	}

	return `${currentStationId}:${icyRawTitle}`;
};

startPolling();

/**
 * Start polling for ICY metadata. A quick poll is also scheduled after user
 * interaction, so starting a station or switching to another one does not
 * have to wait for the regular interval.
 */
function startPolling(): void {
	if (isStarted) {
		return;
	}
	isStarted = true;

	document.addEventListener('click', onDocumentClick, true);
	document.addEventListener('keydown', onDocumentKeyDown, true);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			scheduleQuickPoll();
		}
	});
	window.addEventListener('focus', scheduleQuickPoll);
	window.addEventListener('pagehide', stopPolling);

	void pollMetadata();
}

/**
 * Stop polling.
 */
function stopPolling(): void {
	if (pollTimer !== null) {
		window.clearTimeout(pollTimer);
		pollTimer = null;
	}
	if (quickPollTimer !== null) {
		window.clearTimeout(quickPollTimer);
		quickPollTimer = null;
	}
}

/**
 * Handle clicks that may start playback or switch stations.
 * @param event - Click event
 */
function onDocumentClick(event: MouseEvent): void {
	const target = event.target;
	if (!(target instanceof Element)) {
		return;
	}

	if (
		target.closest(PLAYER_SELECTOR) ||
		target.closest('a[href*="/listen/"]')
	) {
		scheduleQuickPoll();
	}
}

/**
 * Handle keyboard playback toggling.
 * @param event - Keyboard event
 */
function onDocumentKeyDown(event: KeyboardEvent): void {
	if (event.code === 'Space') {
		scheduleQuickPoll();
	}
}

/**
 * Poll metadata soon after the user interacts with the player.
 */
function scheduleQuickPoll(): void {
	if (quickPollTimer !== null) {
		window.clearTimeout(quickPollTimer);
	}
	quickPollTimer = window.setTimeout(() => {
		quickPollTimer = null;
		void pollMetadata();
	}, QUICK_POLL_DELAY);
}

/**
 * Schedule the next regular metadata poll.
 * @param delay - Delay in milliseconds
 */
function scheduleNextPoll(delay = POLL_INTERVAL): void {
	if (pollTimer !== null) {
		window.clearTimeout(pollTimer);
	}
	pollTimer = window.setTimeout(() => {
		pollTimer = null;
		void pollMetadata();
	}, delay);
}

/**
 * Read the current station and update the cached track metadata.
 */
async function pollMetadata(): Promise<void> {
	if (isFetching) {
		scheduleNextPoll(QUICK_POLL_DELAY);
		return;
	}
	isFetching = true;

	try {
		const stationId = getStationId();
		updateStation(stationId);

		if (!stationId || !Connector.isPlaying()) {
			return;
		}

		const rawMetadata =
			await Util.fetchIcyMetadataFromServiceWorker(stationId);
		if (rawMetadata === null) {
			return;
		}

		// The station may have changed while the stream was being sampled.
		if (stationId !== currentStationId || stationId !== getStationId()) {
			return;
		}

		const newTrack = parseIcyMetadata(rawMetadata);
		if (!newTrack) {
			emptyMetadataPolls++;
			if (
				emptyMetadataPolls >= EMPTY_METADATA_POLLS_BEFORE_RESET &&
				icyTrack !== null
			) {
				icyTrack = null;
				icyRawTitle = null;
				Connector.onStateChanged();
			}
			return;
		}

		emptyMetadataPolls = 0;

		if (
			newTrack.artist === icyTrack?.artist &&
			newTrack.track === icyTrack?.track
		) {
			return;
		}

		icyTrack = newTrack;
		icyRawTitle = rawMetadata;
		Connector.onStateChanged();
	} catch {
		// Never let an unexpected error stop the polling loop.
	} finally {
		isFetching = false;
		scheduleNextPoll();
	}
}

/**
 * Update the current station and reset the cached metadata if it changed.
 * @param stationId - ID of the current station
 */
function updateStation(stationId: string | null): void {
	if (stationId === currentStationId) {
		return;
	}

	const hadMetadata = icyTrack !== null;

	currentStationId = stationId;
	icyTrack = null;
	icyRawTitle = null;
	emptyMetadataPolls = 0;

	if (hadMetadata) {
		Connector.onStateChanged();
	}
}

/**
 * Get the ID of the station that is currently tuned in.
 * @returns Station ID or null if no station is selected
 */
function getStationId(): string | null {
	const match = /^\/listen\/[^/]+\/([^/?#]+)/.exec(window.location.pathname);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return match[1];
		}
	}

	// The site stores the playing station in localStorage, which also covers
	// playback started from the globe without a navigation.
	let stored: string | null = null;
	try {
		stored = window.localStorage.getItem('channel');
	} catch {
		return null;
	}

	if (!stored) {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(stored);
		if (typeof parsed === 'string' && parsed) {
			return parsed;
		}
	} catch {
		// Not a JSON string, use the raw value.
	}

	return stored.replace(/^"|"$/g, '') || null;
}

/**
 * Parse the `StreamTitle` field of an ICY metadata block.
 * @param rawMetadata - Raw metadata block
 * @returns Artist and track name or null if the metadata is not usable
 */
function parseIcyMetadata(rawMetadata: string): IcyTrack | null {
	const match =
		/StreamTitle\s*=\s*'(.*?)'\s*(?:;|$)/s.exec(rawMetadata) ??
		/StreamTitle\s*=\s*"(.*?)"\s*(?:;|$)/s.exec(rawMetadata);
	if (!match) {
		return null;
	}

	const title = match[1].replace(/\0/g, '').replace(/\s+/g, ' ').trim();
	if (!isUsableTitle(title)) {
		return null;
	}

	let { artist, track } = Util.splitArtistTrack(title, SEPARATORS);

	// Some stations use the "Track by Artist" format.
	if (!artist || !track) {
		({ artist, track } = Util.splitArtistTrack(title, [' by '], true));
	}

	if (!artist || !track) {
		return null;
	}

	artist = artist.trim();
	track = track.trim();

	if (
		!isUsablePart(artist) ||
		!isUsablePart(track) ||
		IGNORED_TITLES.test(artist) ||
		IGNORED_TITLES.test(track)
	) {
		return null;
	}

	return { artist, track };
}

/**
 * Check whether a `StreamTitle` value is worth scrobbling.
 * @param title - Song title
 * @returns Check result
 */
function isUsableTitle(title: string): boolean {
	if (title.length < 4) {
		return false;
	}

	if (/^[\d\s\-–—]+$/.test(title) || IGNORED_TITLES.test(title)) {
		return false;
	}

	const stationTitle = Util.getTextFromSelectors(STATION_TITLE_SELECTOR);
	if (stationTitle && normalize(title) === normalize(stationTitle)) {
		return false;
	}

	return true;
}

/**
 * Check whether an artist or track name is worth scrobbling.
 * @param value - Artist or track name
 * @returns Check result
 */
function isUsablePart(value: string): boolean {
	return value.length > 0 && !IGNORED_TITLES.test(value);
}

/**
 * Normalize text for comparisons.
 * @param value - Text to normalize
 * @returns Normalized text
 */
function normalize(value: string): string {
	return value
		.normalize('NFKC')
		.toLocaleLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}
