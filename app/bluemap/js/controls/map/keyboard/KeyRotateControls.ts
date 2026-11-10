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

import {MathUtils} from "three";
import {KeyCombination} from "../../KeyCombination";
import type {ControlsLike, ControlsManager} from "../../ControlsManager";
import type {Map} from "../../../map/Map";

export class KeyRotateControls implements ControlsLike {

    static KEYS = {
        LEFT: [
            new KeyCombination("ArrowLeft", KeyCombination.ALT),
            new KeyCombination("KeyA", KeyCombination.ALT),
            new KeyCombination("Delete"),
        ],
        RIGHT: [
            new KeyCombination("ArrowRight", KeyCombination.ALT),
            new KeyCombination("KeyD", KeyCombination.ALT),
            new KeyCombination("End"),
        ],
    }

    target: EventTarget;
    manager: ControlsManager;

    deltaRotation: number;

    left: boolean;
    right: boolean;

    speed: number;
    stiffness: number;

    /**
     * @param target {EventTarget}
     * @param speed {number}
     * @param stiffness {number}
     */
    constructor(target: EventTarget, speed: number, stiffness: number) {
        this.target = target;
        this.manager = null;

        this.deltaRotation = 0;

        this.left = false;
        this.right = false;

        this.speed = speed;
        this.stiffness = stiffness;
    }

    /**
     * @param manager {ControlsManager}
     */
    start(manager: ControlsManager): void {
        this.manager = manager;

        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("blur", this.onStop)
    }

    stop(): void {
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.onStop)
    }

    /**
     * @param delta {number}
     * @param map {Map}
     */
    update(delta: number, map: Map): void {
        if (this.left) this.deltaRotation += 1;
        if (this.right) this.deltaRotation -= 1;

        if (this.deltaRotation === 0) return;

        let smoothing = this.stiffness / (16.666 / delta);
        smoothing = MathUtils.clamp(smoothing, 0, 1);

        this.manager.rotation += this.deltaRotation * smoothing * this.speed * delta * 0.06;

        this.deltaRotation *= 1 - smoothing;
        if (Math.abs(this.deltaRotation) < 0.0001) {
            this.deltaRotation = 0;
        }
    }

    /**
     * @param evt {KeyboardEvent}
     */
    onKeyDown = (evt: KeyboardEvent): void => {
        if (KeyCombination.oneDown(evt, ...KeyRotateControls.KEYS.LEFT)){
            this.left = true;
            evt.preventDefault();
        }
        if (KeyCombination.oneDown(evt, ...KeyRotateControls.KEYS.RIGHT)){
            this.right = true;
            evt.preventDefault();
        }
    }

    /**
     * @param evt {KeyboardEvent}
     */
    onKeyUp = (evt: KeyboardEvent): void => {
        if (KeyCombination.oneUp(evt, ...KeyRotateControls.KEYS.LEFT)){
            this.left = false;
        }
        if (KeyCombination.oneUp(evt, ...KeyRotateControls.KEYS.RIGHT)){
            this.right = false;
        }
    }

    onStop = (evt: FocusEvent): void => {
        this.left = false;
        this.right = false;
    }

}
