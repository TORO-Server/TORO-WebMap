/*
 * This file is part of BlueMap, licensed under the MIT License (MIT).
 *
 * Copyright (c) Blue (Lukas Rieger) <https://bluecolored.de>
 * Copyright (c) contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { PlayerMarkerSet, PlayersJson } from "./PlayerMarkerSet";
import { MarkerManager } from "./MarkerManager";
import type { MarkerSet } from "./MarkerSet";
import type { PlayerMarker } from "./PlayerMarker";

export const PLAYER_MARKER_SET_ID = "bm-players";

export class PlayerMarkerManager extends MarkerManager {

    playerheadsUrl: string;

    /**
     * @constructor
     * @param root {MarkerSet} - The scene to which all markers will be added
     * @param fileUrl {string} - The marker file from which this manager updates its markers
     * @param playerheadsUrl {string} - The url from which playerhead images should be loaded
     * @param events {EventTarget}
     */
    constructor(root: MarkerSet, fileUrl: string, playerheadsUrl: string, events: EventTarget = null, paused: boolean = false) {
        super(root, fileUrl, events, paused);

        this.playerheadsUrl = playerheadsUrl;
    }

    /**
     * @protected
     * @override
     * @param markerFileData
     * @returns {boolean}
     */
    updateFromData(markerFileData: PlayersJson): boolean {
        let playerMarkerSet = this.getPlayerMarkerSet(Array.isArray(markerFileData.players));
        if (!playerMarkerSet) return false;
        return playerMarkerSet.updateFromPlayerData(markerFileData);
    }

    /**
     * @private
     * @returns {PlayerMarkerSet}
     */
    getPlayerMarkerSet(create: boolean = true): PlayerMarkerSet {
        /** @type {PlayerMarkerSet} */
        let playerMarkerSet = /** @type {PlayerMarkerSet} */ this.root.markerSets.get(PLAYER_MARKER_SET_ID) as PlayerMarkerSet;

        if (!playerMarkerSet && create) {
            playerMarkerSet = new PlayerMarkerSet(PLAYER_MARKER_SET_ID, this.playerheadsUrl);
            this.root.add(playerMarkerSet);
        }

        return playerMarkerSet;
    }

    /**
     * @param playerUuid {string}
     * @returns {PlayerMarker | undefined}
     */
    getPlayerMarker(playerUuid: string): PlayerMarker | undefined {
        return this.getPlayerMarkerSet().getPlayerMarker(playerUuid)
    }

    clear(): void {
        this.getPlayerMarkerSet(false)?.clear();
    }

}
