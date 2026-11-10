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

import {MarkerSet, MarkerSetData, MarkerSetJson} from "./MarkerSet";
import {alert} from "../util/Utils";
import {PlayerLike, PlayerMarker} from "./PlayerMarker";
import type {Marker} from "./Marker";

/** A players.json */
export interface PlayersJson {
    players?: PlayerLike[];
}

export interface PlayerMarkerSetData extends MarkerSetData {
    playerheadsUrl: string;
}

export class PlayerMarkerSet extends MarkerSet {

    declare data: PlayerMarkerSetData;

    constructor(id: string, playerheadsUrl: string, data: MarkerSetJson = null) {
        super(id, data);
        this.data.label = "Player";
        this.data.toggleable = true;
        this.data.defaultHide = false;

        this.data.playerheadsUrl = playerheadsUrl;
    }

    updateFromPlayerData(data: PlayersJson): boolean {
        if (!Array.isArray(data.players)) {
            this.clear();
            return false;
        }

        /** @type Set<Marker> */
        let updatedPlayerMarkers = new Set<Marker>();

        // update
        data.players.forEach(playerData => {
            try {
                let playerMarker = this.updatePlayerMarkerFromData(playerData);
                updatedPlayerMarkers.add(playerMarker);
            } catch (err) {
                alert(this.events, err, "fine");
            }
        });

        // remove
        this.markers.forEach(playerMarker => {
            if (!updatedPlayerMarkers.has(playerMarker)) {
                this.remove(playerMarker);
            }
        });

        return true;
    }

    updatePlayerMarkerFromData(markerData: PlayerLike): PlayerMarker {
        let playerUuid = markerData.uuid;
        if (!playerUuid) throw new Error("player-data has no uuid!");
        let markerId = this.getPlayerMarkerId(playerUuid);

        /** @type PlayerMarker */
        let marker = this.markers.get(markerId) as PlayerMarker;

        // create new if not existent of wrong type
        if (!marker || !marker.isPlayerMarker) {
            if (marker) this.remove(marker);
            marker = new PlayerMarker(markerId, playerUuid, `${this.data.playerheadsUrl}${playerUuid}.png`);
            this.add(marker);
        }

        // update
        marker.updateFromData(markerData);

        // hide if from different world
        marker.visible = !markerData.foreign;

        return marker;
    }

    getPlayerMarker(playerUuid: string): PlayerMarker | undefined {
        return this.markers.get(this.getPlayerMarkerId(playerUuid)) as PlayerMarker;
    }

    getPlayerMarkerId(playerUuid: string): string {
        return "bm-player-" + playerUuid;
    }

}
