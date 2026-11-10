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
import {Camera, Intersection, MathUtils, Object3D, Vector3} from "three";
import {reactive} from "vue";

/** A position as it is written in a markers.json / players.json, missing coordinates count as 0 */
export interface PositionJson {
    x?: number;
    y?: number;
    z?: number;
}

/** A color as it is written in a markers.json (r, g, b: 0-255, a: 0-1) */
export interface ColorLike {
    r?: number;
    g?: number;
    b?: number;
    a?: number;
}

/** The data of one marker in a markers.json, the subclasses of Marker extend this with their own fields */
export interface MarkerJson {
    type?: string;
    position?: PositionJson;
    label?: string;
    sorting?: number;
    listed?: boolean;
}

/** The reactive state of a marker (Marker.data), used by the vue components */
export interface MarkerData {
    id: string;
    type: string;
    sorting: number;
    listed: boolean;
    position: Vector3;
    visible: boolean;
    /** set by most subclasses, the marker list shows it */
    label?: string;
}

/**
 * The event object passed to onClick() (see Object3D.prototype.onClick in BlueMap.ts).
 * MapViewer passes data + intersection, CSS2DObject passes data + the DOM event.
 */
export interface MarkerClickEvent {
    data: {doubleTap?: boolean};
    intersection?: Intersection;
    event?: Event;
    eventStack?: Object3D[];
}

export class Marker extends Object3D {

    declare readonly isMarker: true;
    data: MarkerData;

    /**
     * @param markerId {string}
     */
    constructor(markerId: string) {
        super();
        Object.defineProperty(this, 'isMarker', {value: true});

        this.data = reactive<MarkerData>({
            id: markerId,
            type: "marker",
            sorting: 0,
            listed: true,
            position: this.position,
            visible: this.visible
        });

        // redirect parent properties
        Object.defineProperty(this, "position", {
            get() { return this.data.position },
            set(value) { this.data.position = value }
        });
        Object.defineProperty(this, "visible", {
            get() { return this.data.visible },
            set(value) { this.data.visible = value }
        });
    }

    dispose(): void {}

    /**
     * Updates this marker from the provided data object, usually parsed form json from a markers.json
     * @param markerData {object}
     */
    updateFromData(markerData: MarkerJson): void {}

    // -- helper methods --

    static _posRelativeToCamera = new Vector3();
    static _cameraDirection = new Vector3();

    /**
     * @param position {Vector3}
     * @param camera {Camera}
     * @param fadeDistanceMax {number}
     * @param fadeDistanceMin {number}
     * @returns {number} - opacity between 0 and 1
     */
    static calculateDistanceOpacity(position: Vector3, camera: Camera, fadeDistanceMin: number, fadeDistanceMax: number): number {
        let distance = Marker.calculateDistanceToCameraPlane(position, camera);
        let minDelta = (distance - fadeDistanceMin) / fadeDistanceMin;
        let maxDelta = (distance - fadeDistanceMax) / (fadeDistanceMax * 0.5);
        return Math.min(
            MathUtils.clamp(minDelta, 0, 1),
            1 - MathUtils.clamp(maxDelta + 1, 0, 1)
        );
    }

    /**
     * @param position {Vector3}
     * @param camera {Camera}
     * @returns {number}
     */
    static calculateDistanceToCameraPlane (position: Vector3, camera: Camera): number {
        Marker._posRelativeToCamera.subVectors(position, camera.position);
        camera.getWorldDirection(Marker._cameraDirection);
        return Marker._posRelativeToCamera.dot(Marker._cameraDirection);
    }

}
