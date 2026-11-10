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
import {Color, DoubleSide, ExtrudeGeometry, Mesh, ShaderMaterial, Shape, SRGBColorSpace, UniformsUtils, Vector2, WebGLRenderer} from "three";
import {LineMaterial} from "three/examples/jsm/lines/LineMaterial.js";
import {MARKER_FILL_VERTEX_SHADER} from "./MarkerFillVertexShader";
import {MARKER_FILL_FRAGMENT_SHADER} from "./MarkerFillFragmentShader";
import {Line2} from "three/examples/jsm/lines/Line2.js";
import {deepEquals} from "../util/Utils";
import {LineSegmentsGeometry} from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import {ObjectMarker, ObjectMarkerJson} from "./ObjectMarker";
import {lineShader} from "../util/LineShader";
import type {LineGeometry} from "three/examples/jsm/lines/LineGeometry.js";
import {ColorLike, MarkerClickEvent, PositionJson} from "./Marker";

export interface ExtrudeMarkerJson extends ObjectMarkerJson {
    shape?: PositionJson[];
    shapeMinY?: number;
    shapeMaxY?: number;
    holes?: PositionJson[][];
    depthTest?: boolean;
    lineWidth?: number;
    lineColor?: ColorLike;
    fillColor?: ColorLike;
    minDistance?: number;
    maxDistance?: number;
}

export class ExtrudeMarker extends ObjectMarker {

    declare readonly isExtrudeMarker: true;
    fill: ExtrudeMarkerFill;
    border: ExtrudeMarkerBorder;
    _markerData: ExtrudeMarkerJson;

    /**
     * @param markerId {string}
     */
    constructor(markerId: string) {
        super(markerId);
        Object.defineProperty(this, 'isExtrudeMarker', {value: true});
        this.data.type = "extrude";

        let zero = new Vector2();
        let shape = new Shape([zero, zero, zero]);
        this.fill = new ExtrudeMarkerFill(shape);
        this.border = new ExtrudeMarkerBorder(shape);
        this.border.renderOrder = -1; // render border before fill

        this.add(this.border, this.fill);

        this._markerData = {};
    }

    /**
     * @param minY {number}
     * @param maxY {number}
     */
    setShapeY(minY: number, maxY: number): void {
        let relativeY = maxY - this.position.y;
        let height = maxY - minY;
        this.fill.position.y = relativeY;
        this.border.position.y = relativeY;
        this.fill.scale.y = height;
        this.border.scale.y = height;
    }

    /**
     * @param shape {Shape}
     */
    setShape(shape: Shape): void {
        this.fill.updateGeometry(shape);
        this.border.updateGeometry(shape);
    }

    /**
     * @typedef {{r: number, g: number, b: number, a: number}} ColorLike
     */

    /**
     * @param markerData {{
     *      position: {x: number, y: number, z: number},
     *      label: string,
     *      detail: string,
     *      shape: {x: number, z: number}[],
     *      shapeMinY: number,
     *      shapeMaxY: number,
     *      holes: {x: number, z: number}[][],
     *      link: string,
     *      newTab: boolean,
     *      depthTest: boolean,
     *      lineWidth: number,
     *      lineColor: ColorLike,
     *      fillColor: ColorLike,
     *      minDistance: number,
     *      maxDistance: number
     *      }}
     */
    updateFromData(markerData: ExtrudeMarkerJson): void {
        super.updateFromData(markerData);

        // update shape only if needed, based on last update-data
        if (
            !this._markerData.shape || !deepEquals(markerData.shape, this._markerData.shape) ||
            !this._markerData.holes || !deepEquals(markerData.holes, this._markerData.holes) ||
            !this._markerData.position || !deepEquals(markerData.position, this._markerData.position)
        ){
            // a missing "shape" gives false here, which is passed on unchecked like in the original JS
            this.setShape(this.createShapeWithHolesFromData(markerData.shape, markerData.holes) as Shape);
        }

        // update shapeY
        this.setShapeY((markerData.shapeMinY || 0) - 0.01, (markerData.shapeMaxY || 0) + 0.01); // offset by 0.01 to avoid z-fighting

        // update depthTest
        this.border.depthTest = !!markerData.depthTest;
        this.fill.depthTest = !!markerData.depthTest;

        // update border-width
        this.border.linewidth = markerData.lineWidth !== undefined ? markerData.lineWidth : 2;

        // update border-color
        let bc: ColorLike = markerData.lineColor || {};
        this.border.color.setRGB((bc.r || 0) / 255, (bc.g || 0) / 255, (bc.b || 0) / 255, SRGBColorSpace);
        this.border.opacity = bc.a || 0;

        // update fill-color
        let fc: ColorLike = markerData.fillColor || {};
        this.fill.color.setRGB((fc.r || 0) / 255, (fc.g || 0) / 255, (fc.b || 0) / 255);
        this.fill.opacity = fc.a || 0;

        // update min/max distances
        let minDist = markerData.minDistance || 0;
        let maxDist = markerData.maxDistance !== undefined ? markerData.maxDistance : Number.MAX_VALUE;
        this.border.fadeDistanceMin = minDist;
        this.border.fadeDistanceMax = maxDist;
        this.fill.fadeDistanceMin = minDist;
        this.fill.fadeDistanceMax = maxDist;

        // save used marker data for next update
        this._markerData = markerData;
    }

    dispose(): void {
        super.dispose();

        this.fill.dispose();
        this.border.dispose();
    }

    /**
     * @private
     * Creates a shape from a data object, usually parsed json from a markers.json
     * @param shapeData {{x: number, z: number}[]}
     * @returns {Shape | false}
     */
    createShapeFromData(shapeData: PositionJson[]): Shape | false {
        /** @type {Vector2[]} **/
        let points: Vector2[] = [];

        if (Array.isArray(shapeData)){
            shapeData.forEach(point => {
                let x = (point.x || 0) - this.position.x + 0.01; // offset by 0.01 to avoid z-fighting
                let z = (point.z || 0) - this.position.z + 0.01;

                points.push(new Vector2(x, z));
            });

            return new Shape(points);
        }

        return false;
    }

    /**
     * @private
     * Creates a shape with holes from a data object, usually parsed json from a markers.json
     * @param shapeData {{x: number, z: number}[]}
     * @param holes {{x: number, z: number}[][]}
     * @returns {Shape}
     */
    createShapeWithHolesFromData(shapeData: PositionJson[], holes: PositionJson[][]): Shape | false {
        const shape = this.createShapeFromData(shapeData);

        if (shape && Array.isArray(holes)){
            holes.forEach(hole => {
                const holeShape = this.createShapeFromData(hole);
                if (holeShape) {
                    shape.holes.push(holeShape);
                }
            })
        }

        return shape;
    }

}

class ExtrudeMarkerFill extends Mesh<ExtrudeGeometry, ShaderMaterial> {

    /**
     * @param shape {Shape}
     */
    constructor(shape: Shape) {
        let geometry = ExtrudeMarkerFill.createGeometry(shape);
        let material = new ShaderMaterial({
            vertexShader: MARKER_FILL_VERTEX_SHADER,
            fragmentShader: MARKER_FILL_FRAGMENT_SHADER,
            side: DoubleSide,
            depthTest: true,
            transparent: true,
            uniforms: {
                markerColor: { value: new Color() },
                markerOpacity: { value: 0 },
                fadeDistanceMin: { value: 0 },
                fadeDistanceMax: { value: Number.MAX_VALUE },
            }
        });

        super(geometry, material);
    }

    /**
     * @returns {Color}
     */
    get color(): Color {
        return this.material.uniforms.markerColor.value;
    }

    /**
     * @returns {number}
     */
    get opacity(): number {
        return this.material.uniforms.markerOpacity.value;
    }

    /**
     * @param opacity {number}
     */
    set opacity(opacity: number) {
        this.material.uniforms.markerOpacity.value = opacity;
        this.visible = opacity > 0;
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
     * @param shape {Shape}
     */
    updateGeometry(shape: Shape): void {
        this.geometry.dispose();
        this.geometry = ExtrudeMarkerFill.createGeometry(shape);
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
    }

    /**
     * @param shape {Shape}
     * @returns {ExtrudeGeometry}
     */
    static createGeometry(shape: Shape): ExtrudeGeometry {
        let geometry = new ExtrudeGeometry(shape, {
            depth: 1,
            steps: 5,
            bevelEnabled: false
        });
        geometry.rotateX(Math.PI / 2); //make y to z

        return geometry;
    }

}

class ExtrudeMarkerBorder extends Line2 {

    /**
     * @param shape {Shape}
     */
    constructor(shape: Shape) {
        let geometry = new LineSegmentsGeometry();
        geometry.setPositions(ExtrudeMarkerBorder.createLinePoints(shape));

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

        // Line2 is typed for a LineGeometry, the border uses a LineSegmentsGeometry (separate segments) like in the original JS
        super(geometry as LineGeometry, material);

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
     * @param shape {Shape}
     */
    updateGeometry(shape: Shape): void {
        this.geometry = new LineSegmentsGeometry() as LineGeometry;
        this.geometry.setPositions(ExtrudeMarkerBorder.createLinePoints(shape));
        this.computeLineDistances();
    }

    /**
     * @param renderer {WebGLRenderer}
     */
    onBeforeRender(renderer: WebGLRenderer): void {
        renderer.getSize(this.material.resolution);
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
    }

    /**
     * @param shape {Shape}
     * @returns {number[]}
     */
    static createLinePoints(shape: Shape): number[] {
        let points3d: number[] = [];

        points3d.push(...this.convertPoints(shape.getPoints(5)));
        shape.getPointsHoles(5).forEach(hole => points3d.push(...this.convertPoints(hole)));

        return points3d;
    }

    /**
     * @private
     * @param points {{x: number, y: number}[]}
     * @return {number[]}
     */
    static convertPoints(points: {x: number, y: number}[]): number[] {
        let points3d: number[] = [];
        points.push(points[0]);

        let prevPoint: {x: number, y: number} = null;
        points.forEach(point => {

            // vertical line
            points3d.push(point.x, 0, point.y);
            points3d.push(point.x, -1, point.y);

            if (prevPoint) {
                // line to previous point top
                points3d.push(prevPoint.x, 0, prevPoint.y);
                points3d.push(point.x, 0, point.y);

                // line to previous point bottom
                points3d.push(prevPoint.x, -1, prevPoint.y);
                points3d.push(point.x, -1, point.y);
            }

            prevPoint = point;
        });

        return points3d;
    }

}
