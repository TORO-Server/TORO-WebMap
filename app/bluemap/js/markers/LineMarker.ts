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
import {Color, Curve, SRGBColorSpace, UniformsUtils, Vector3, WebGLRenderer} from "three";
import {LineMaterial} from "three/examples/jsm/lines/LineMaterial.js";
import {LineGeometry} from "three/examples/jsm/lines/LineGeometry.js";
import {Line2} from "three/examples/jsm/lines/Line2.js";
import {deepEquals} from "../util/Utils";
import {ObjectMarker, ObjectMarkerJson} from "./ObjectMarker";
import {lineShader} from "../util/LineShader";
import {ColorLike, MarkerClickEvent, PositionJson} from "./Marker";

export interface LineMarkerJson extends ObjectMarkerJson {
    line?: PositionJson[];
    depthTest?: boolean;
    lineWidth?: number;
    lineColor?: ColorLike;
    minDistance?: number;
    maxDistance?: number;
}

export class LineMarker extends ObjectMarker {

    declare readonly isLineMarker: true;
    line: LineMarkerLine;
    _markerData: LineMarkerJson;

    /**
     * @param markerId {string}
     */
    constructor(markerId: string) {
        super(markerId);
        Object.defineProperty(this, 'isLineMarker', {value: true});
        this.data.type = "line";

        this.line = new LineMarkerLine([0, 0, 0]);

        this.add(this.line);

        this._markerData = {};
    }

    /**
     * @param line {number[] | THREE.Vector3[] | THREE.Curve}
     */
    setLine(line: number[] | Vector3[] | Curve<Vector3>): void {
        /** @type {number[]} */
        let points: number[];

        if ((line as Curve<Vector3>).type === 'Curve' || (line as Curve<Vector3>).type === 'CurvePath') {
            line = (line as Curve<Vector3>).getPoints(5);
        }

        if (Array.isArray(line)) {
            if (line.length === 0){
                points = [];
            } else if ((line[0] as Vector3).isVector3) {
                points = [];
                (line as Vector3[]).forEach(point => {
                    points.push(point.x, point.y, point.z);
                });
            } else {
                points = line as number[];
            }
        } else {
            throw new Error("Invalid argument type!");
        }

        this.line.updateGeometry(points);
    }

    /**
     * @typedef {{r: number, g: number, b: number, a: number}} ColorLike
     */

    /**
     * @param markerData {{
     *      position: {x: number, y: number, z: number},
     *      label: string,
     *      detail: string,
     *      line: {x: number, y: number, z: number}[],
     *      link: string,
     *      newTab: boolean,
     *      depthTest: boolean,
     *      lineWidth: number,
     *      lineColor: ColorLike,
     *      minDistance: number,
     *      maxDistance: number
     *      }}
     */
    updateFromData(markerData: LineMarkerJson): void {
        super.updateFromData(markerData);

        // update shape only if needed, based on last update-data
        if (
            !this._markerData.line || !deepEquals(markerData.line, this._markerData.line) ||
            !this._markerData.position || !deepEquals(markerData.position, this._markerData.position)
        ){
            this.setLine(this.createPointsFromData(markerData.line));
        }

        // update depthTest
        this.line.depthTest = !!markerData.depthTest;

        // update border-width
        this.line.linewidth = markerData.lineWidth !== undefined ? markerData.lineWidth : 2;

        // update line-color
        let lc: ColorLike = markerData.lineColor || {};
        this.line.color.setRGB((lc.r || 0) / 255, (lc.g || 0) / 255, (lc.b || 0) / 255, SRGBColorSpace);
        this.line.opacity = lc.a || 0;

        // update min/max distances
        let minDist = markerData.minDistance || 0;
        let maxDist = markerData.maxDistance !== undefined ? markerData.maxDistance : Number.MAX_VALUE;
        this.line.fadeDistanceMin = minDist;
        this.line.fadeDistanceMax = maxDist;

        // save used marker data for next update
        this._markerData = markerData;
    }

    dispose(): void {
        super.dispose();

        this.line.dispose();
    }

    /**
     * @private
     * Creates a shape from a data object, usually parsed json from a markers.json
     * @param shapeData {object}
     * @returns {number[]}
     */
    createPointsFromData(shapeData: PositionJson[]): number[] {
        /** @type {number[]} **/
        let points: number[] = [];

        if (Array.isArray(shapeData)){
            shapeData.forEach(point => {
                let x = (point.x || 0) - this.position.x;
                let y = (point.y || 0) - this.position.y;
                let z = (point.z || 0) - this.position.z;

                points.push(x, y, z);
            });
        }

        return points;
    }

}

class LineMarkerLine extends Line2 {

    /**
     * @param points {number[]}
     */
    constructor(points: number[]) {
        let geometry = new LineGeometry();
        geometry.setPositions(points);

        let material = new LineMaterial({
            color: new Color(),
            opacity: 0,
            transparent: true,
            linewidth: 1,
            depthTest: true,
            vertexColors: false,
            dashed: false,
            uniforms: UniformsUtils.clone( lineShader.uniforms ),
            vertexShader: lineShader.vertexShader,
            fragmentShader: lineShader.fragmentShader
        });
        material.uniforms.fadeDistanceMin = { value: 0 };
        material.uniforms.fadeDistanceMax = { value: Number.MAX_VALUE };

        material.resolution.set(window.innerWidth, window.innerHeight);

        super(geometry, material);

        this.computeLineDistances();
    }

    /**
     * @returns {Color}
     */
    get color(): Color {
        return this.material.color;
    }

    /**
     * @returns {number}
     */
    get opacity(): number {
        return this.material.opacity;
    }

    /**
     * @param opacity {number}
     */
    set opacity(opacity: number) {
        this.material.opacity = opacity;
        this.visible = opacity > 0;
    }

    /**
     * @returns {number}
     */
    get linewidth(): number {
        return this.material.linewidth;
    }

    /**
     * @param width {number}
     */
    set linewidth(width: number) {
        this.material.linewidth = width;
    }

    /**
     * @returns {boolean}
     */
    get depthTest(): boolean {
        return this.material.depthTest;
    }

    /**
     * @param test {boolean}
     */
    set depthTest(test: boolean) {
        this.material.depthTest = test;
    }

    /**
     * @returns {number}
     */
    get fadeDistanceMin(): number {
        return this.material.uniforms.fadeDistanceMin.value;
    }

    /**
     * @param min {number}
     */
    set fadeDistanceMin(min: number) {
        this.material.uniforms.fadeDistanceMin.value = min;
    }

    /**
     * @returns {number}
     */
    get fadeDistanceMax(): number {
        return this.material.uniforms.fadeDistanceMax.value;
    }

    /**
     * @param max {number}
     */
    set fadeDistanceMax(max: number) {
        this.material.uniforms.fadeDistanceMax.value = max;
    }

    onClick(event: MarkerClickEvent): boolean {
        if (event.intersection) {
            if (event.intersection.distance > this.fadeDistanceMax) return false;
            if (event.intersection.distance < this.fadeDistanceMin) return false;
        }

        return super.onClick(event);
    }

    /**
     * @param points {number[]}
     */
    updateGeometry(points: number[]): void {
        this.geometry = new LineGeometry();
        this.geometry.setPositions(points);
        this.computeLineDistances();
    }

    /**
     * @param renderer {THREE.WebGLRenderer}
     */
    onBeforeRender(renderer: WebGLRenderer): void {
        renderer.getSize(this.material.resolution);
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
    }

}
