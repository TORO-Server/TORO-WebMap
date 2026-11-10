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
import {Marker, MarkerData, MarkerJson, PositionJson} from "./Marker";
import {CSS2DObject} from "../util/CSS2DRenderer";
import {htmlToElement} from "../util/Utils";
import {Camera, Scene, Vector2, WebGLRenderer} from "three";
import {sanitizeHtml} from "../../../lib/sanitize-html";

export interface AnchorJson {
    x?: number;
    y?: number;
}

export interface HtmlMarkerJson extends MarkerJson {
    anchor?: AnchorJson;
    html?: string;
    classes?: string[];
    minDistance?: number;
    maxDistance?: number;
}

export interface HtmlMarkerData extends MarkerData {
    label: string;
    classes: string[];
}

export class HtmlMarker extends Marker {

    declare readonly isHtmlMarker: true;
    declare data: HtmlMarkerData;
    elementObject: CSS2DObject;
    fadeDistanceMin: number;
    fadeDistanceMax: number;

    /**
     * @param markerId {string}
     */
    constructor(markerId: string) {
        super(markerId);
        Object.defineProperty(this, 'isHtmlMarker', {value: true});
        this.data.type = "html";

        this.data.label = null;

        this.data.classes = [];

        // CSS2DObject は親のある要素を受け取る (htmlToElement の要素には親がある)
        const root = htmlToElement(`<div class="bm-marker-${this.data.type}"></div>`);
        root.id = `bm-marker-${this.data.id}`;
        this.elementObject = new CSS2DObject(root);
        this.elementObject.onBeforeRender = (renderer, scene, camera) => this.onBeforeRender(renderer, scene, camera);

        this.fadeDistanceMin = 0;
        this.fadeDistanceMax = Number.MAX_VALUE;

        this.addEventListener( 'removed', () => {
            if (this.element?.parentNode) this.element.parentNode.removeChild(this.element);
        });

        this.add(this.elementObject);
    }

    onBeforeRender(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
        if (this.fadeDistanceMax === Number.MAX_VALUE && this.fadeDistanceMin <= 0){
            (this.element.parentNode as HTMLElement).style.opacity = undefined;
        } else {
            (this.element.parentNode as HTMLElement).style.opacity = Marker.calculateDistanceOpacity(this.position, camera, this.fadeDistanceMin, this.fadeDistanceMax).toString();
        }
    }

    /**
     * @returns {string}
     */
    get html(): string {
        return this.element.innerHTML;
    }

    /**
     * @param html {string}
     */
    set html(html: string) {
        this.element.innerHTML = sanitizeHtml(html);
    }

    /**
     * @returns {THREE.Vector2}
     */
    get anchor(): Vector2 {
        return this.elementObject.anchor;
    }

    /**
     * @returns {Element}
     */
    get element(): HTMLDivElement {
        return this.elementObject.element.getElementsByTagName("div")[0];
    }

    /**
     * @param markerData {{
     *      position: {x: number, y: number, z: number},
     *      label: string,
     *      sorting: number,
     *      listed: boolean,
     *      anchor: {x: number, y: number},
     *      html: string,
     *      classes: string[],
     *      minDistance: number,
     *      maxDistance: number
     *      }}
     */
    updateFromData(markerData: HtmlMarkerJson): void {

        // update position
        let pos: PositionJson = markerData.position || {};
        this.position.setX(pos.x || 0);
        this.position.setY(pos.y || 0);
        this.position.setZ(pos.z || 0);

        // update label
        if (this.data.label !== markerData.label) {
            this.data.label = markerData.label || null;
        }

        //update sorting
        if (this.data.sorting !== markerData.sorting) {
            this.data.sorting = markerData.sorting || 0;
        }

        //update listed
        if (this.data.listed !== markerData.listed) {
            this.data.listed = markerData.listed === undefined ? true : markerData.listed;
        }

        // update anchor
        let anch: AnchorJson = markerData.anchor || {};
        this.anchor.setX(anch.x || 0);
        this.anchor.setY(anch.y || 0);

        // update html
        const clean = sanitizeHtml(markerData.html);
        if (this.element.innerHTML !== clean){
            this.element.innerHTML = clean;
        }

        // update style-classes
        if (this.data.classes !== markerData.classes) {
            this.data.classes = markerData.classes;
            this.element.classList.value = `bm-marker-${this.data.type}`;
            this.element.classList.add(...markerData.classes);
        }

        // update min/max distances
        this.fadeDistanceMin = markerData.minDistance || 0;
        this.fadeDistanceMax = markerData.maxDistance !== undefined ? markerData.maxDistance : Number.MAX_VALUE;

    }

    dispose(): void {
        super.dispose();

        if (this.element.parentNode) this.element.parentNode.removeChild(this.element);
    }

}
