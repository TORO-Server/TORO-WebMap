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
import "./BlueMap";
import {MapViewer} from "./MapViewer";
import {MapControls} from "./controls/map/MapControls";
import {FreeFlightControls} from "./controls/freeflight/FreeFlightControls";
import {MathUtils, Vector3} from "three";
import {Map as BlueMapMap} from "./map/Map";
import {alert, animate, EasingFunctions, hashTile} from "./util/Utils";
import {MainMenu} from "./MainMenu";
import {PopupMarker} from "./PopupMarker";
import {MarkerSet} from "./markers/MarkerSet";
import {getLocalStorage, round, setLocalStorage} from "./Utils";
import {RevalidatingFileLoader} from "./util/RevalidatingFileLoader";
import {i18n, setLanguage} from "../i18n";
import {PlayerMarkerManager} from "./markers/PlayerMarkerManager";
import {NormalMarkerManager} from "./markers/NormalMarkerManager";
import {reactive} from "vue";
import type {MapInteractionEventDetail} from "./MapViewer";
import type {FollowedPlayer} from "./controls/ControlsManager";

/** settings.json (merged with the defaults in getSettings()) */
export interface BlueMapSettings {
    version: string;
    useCookies: boolean;
    defaultToFlatView: boolean;
    resolutionDefault: number;
    minZoomDistance: number;
    maxZoomDistance: number;
    hiresSliderMax: number;
    hiresSliderDefault: number;
    hiresSliderMin: number;
    lowresSliderMax: number;
    lowresSliderDefault: number;
    lowresSliderMin: number;
    startLocation?: string;
    mapDataRoot: string;
    liveDataRoot: string;
    maps: string[];
    scripts: string[];
    styles: string[];
    clientDecompression: boolean;
}

export interface AppState {
    controls: {
        state: "perspective" | "flat" | "free";
        mouseSensitivity: number;
        showZoomButtons: boolean;
        invertMouse: boolean;
        pauseTileLoading: boolean;
    };
    menu: MainMenu;
    maps: BlueMapMap["data"][];
    theme: string;
    screenshot: {
        clipboard: boolean;
    };
    debug: boolean;
}

/**
 * settings.json の scripts のうち、この画面が代わりに持っているもの。
 * MarumaSign Companion が足す看板の 3D 表示 (js/marumasign3d.js?v=...) は app/bluemap/marumasign/ が同じことをするので読まない
 * (手元で前のスクリプトと見比べるときは、npm run dev で ?marumasign=legacy を付けると読む)
 * toro-refresh.js は、ブラウザに残っている前の画面を読み直させるもの (toro-edge が足す)。この画面には要らない
 */
export function isReplacedScript(url: string): boolean {
    if (/(^|\/)toro-refresh\.js([?#]|$)/i.test(url)) return true;
    if (import.meta.env.DEV && /[?&]marumasign=legacy\b/.test(window.location.search)) return false;
    return /(^|\/)marumasign3d\.js([?#]|$)/i.test(url);
}

/** live/players.json */
interface PlayersFileData {
    players?: {
        uuid: string;
        foreign?: boolean;
        [key: string]: any;
    }[];
}

export class BlueMapApp {

    events: HTMLElement;
    mapViewer: MapViewer;
    mapControls: MapControls;
    freeFlightControls: FreeFlightControls;

    playerMarkerManager: PlayerMarkerManager;
    markerFileManager: NormalMarkerManager;

    mapEventSource: EventSource;
    liveSocket: WebSocket | null = null;
    liveRetryTimer: ReturnType<typeof setTimeout> | null = null;

    settings: BlueMapSettings;
    savedUserSettings: Map<string, unknown>;

    maps: BlueMapMap[];
    mapsMap: Map<string, BlueMapMap>;

    lastCameraMove: number;

    mainMenu: MainMenu;
    appState: AppState;

    popupMarkerSet: MarkerSet;
    popupMarker: PopupMarker;

    updateLoop: ReturnType<typeof setTimeout>;
    hashUpdateTimeout: ReturnType<typeof setTimeout>;
    viewAnimation: ReturnType<typeof animate>;

    /**
     * @param rootElement {Element}
     */
    constructor(rootElement: HTMLElement) {
        this.events = rootElement;

        this.mapViewer = new MapViewer(rootElement, this.events);

        this.mapControls = new MapControls(this.mapViewer.renderer.domElement, rootElement);
        this.freeFlightControls = new FreeFlightControls(this.mapViewer.renderer.domElement);

        /** @type {PlayerMarkerManager} */
        this.playerMarkerManager = null;
        /** @type {NormalMarkerManager} */
        this.markerFileManager = null;

        /** @type {EventSource}  */
        this.mapEventSource = null;

        /** @type {{
         *      version: string,
         *      useCookies: boolean,
         *      defaultToFlatView: boolean,
         *      resolutionDefault: number,
         *      minZoomDistance: number,
         *      maxZoomDistance: number,
         *      hiresSliderMax: number,
         *      hiresSliderDefault: number,
         *      hiresSliderMin: number,
         *      lowresSliderMax: number,
         *      lowresSliderDefault: number,
         *      lowresSliderMin: number,
         *      startLocation: string,
         *      mapDataRoot: string,
         *      liveDataRoot: string,
         *      maps: string[],
         *      scripts: string[],
         *      styles: string[]
         *      clientDecompression: boolean,
         *  }}
         **/
        this.settings = null;
        this.savedUserSettings = new Map();

        /** @type BlueMapMap[] */
        this.maps = [];
        /** @type Map<BlueMapMap> */
        this.mapsMap = new Map();

        this.lastCameraMove = 0;

        this.mainMenu = reactive(new MainMenu());

        this.appState = reactive<AppState>({
            controls: {
                state: "perspective",
                mouseSensitivity: 1,
                showZoomButtons: true,
                invertMouse: false,
                pauseTileLoading: false
            },
            menu: this.mainMenu,
            maps: [],
            theme: null,
            screenshot: {
                clipboard: true
            },
            debug: false
        });

        // close the live connection (WebSocket / SSE) when the page is closed
        window.addEventListener("beforeunload", () => {
            this.closeLive();
        });

        // init
        this.updateControlsSettings();
        this.initGeneralEvents();

        // popup on click
        this.popupMarkerSet = new MarkerSet("bm-popup-set");
        this.popupMarkerSet.data.toggleable = false;
        this.popupMarker = new PopupMarker("bm-popup", this.appState, this.events);
        this.popupMarkerSet.add(this.popupMarker);
        this.mapViewer.markers.add(this.popupMarkerSet);

        this.updateLoop = null;

        this.hashUpdateTimeout = null;
        this.viewAnimation = null;
    }


    /**
     * @returns {Promise<void|never>}
     */
    async load(): Promise<void> {
        let oldMaps = this.maps;
        this.maps = [];
        this.appState.maps.splice(0, this.appState.maps.length);
        this.mapsMap.clear();

        // load settings
        await this.getSettings();
        this.mapControls.minDistance = this.settings.minZoomDistance;
        this.mapControls.maxDistance = this.settings.maxZoomDistance;

        // load settings-styles
        if (this.settings.styles) for (let styleUrl of this.settings.styles) {
            let styleElement = document.createElement("link");
            styleElement.rel = "stylesheet";
            styleElement.href = styleUrl;
            alert(this.events, "Loading style: " + styleUrl, "fine");
            document.head.appendChild(styleElement);
        }

        // unload loaded maps
        await this.mapViewer.switchMap(null);
        oldMaps.forEach(map => map.dispose());

        // load user settings
        await this.loadUserSettings();

        // load maps
        this.maps = await this.loadMaps();
        for (let map of this.maps) {
            this.mapsMap.set(map.data.id, map);
            this.appState.maps.push(map.data);
        }

        // switch to map
        try {
            if (!await this.loadPageAddress()) {
                if (this.maps.length > 0) await this.switchMap(this.maps[0].data.id);
                this.resetCamera();
            }
        } catch (e) {
            console.error("Failed to load map!", e);
        }

        // map position address
        window.addEventListener("hashchange", this.loadPageAddress);
        this.events.addEventListener("bluemapCameraMoved", this.cameraMoved);
        this.events.addEventListener("bluemapMapInteraction", this.mapInteraction as EventListener);

        // start app update loop
        if(this.updateLoop) clearTimeout(this.updateLoop);
        this.updateLoop = setTimeout(this.update, 1000);

        // save user settings
        this.saveUserSettings();

        // load settings-scripts
        if (this.settings.scripts) for (let scriptUrl of this.settings.scripts) {
            // MarumaSign Companion の看板のスクリプトは読まない (この画面の app/bluemap/marumasign/ が同じことをする)
            if (isReplacedScript(scriptUrl)) continue;
            let scriptElement = document.createElement("script");
            scriptElement.src = scriptUrl;
            alert(this.events, "Loading script: " + scriptUrl, "fine");
            document.body.appendChild(scriptElement);
        }
    }

    update = async (): Promise<void> => {
        await this.followPlayerMarkerWorld();
        this.updateLoop = setTimeout(this.update, 1000);
    }

    async followPlayerMarkerWorld(): Promise<void> {
        /** @type {PlayerLike} */
        let player: FollowedPlayer = this.mapViewer.controlsManager.controls?.data.followingPlayer;

        if (this.mapViewer.map && player) {
            if (player.foreign){

                let matchingMap = await this.findPlayerMap(player.playerUuid)
                if (matchingMap) {
                    this.mainMenu.closeAll();
                    await this.switchMap(matchingMap.data.id, false);
                    let playerMarker = this.playerMarkerManager.getPlayerMarker(player.playerUuid);
                    if (playerMarker && this.mapViewer.controlsManager.controls.followPlayerMarker)
                        this.mapViewer.controlsManager.controls.followPlayerMarker(playerMarker);
                } else {
                    if (this.mapViewer.controlsManager.controls.stopFollowingPlayerMarker)
                        this.mapViewer.controlsManager.controls.stopFollowingPlayerMarker();
                }
            }
        }
    }

    async findPlayerMap(playerUuid: string): Promise<BlueMapMap> {
        /** @type BlueMapMap */
        let matchingMap: BlueMapMap = null;

        // search for the map that contains the player
        if (this.maps.length < 20) {
            for (let map of this.maps) {
                let playerData = await this.loadPlayerData(map);
                if (!Array.isArray(playerData.players)) continue;
                for (let p of playerData.players) {
                    if (p.uuid === playerUuid && !p.foreign) {
                        matchingMap = map;
                        break;
                    }
                }

                if (matchingMap) break;
            }
        }

        return matchingMap;
    }

    /**
     * @param mapId {String}
     * @param resetCamera {boolean}
     * @returns {Promise<void>}
     */
    async switchMap(mapId: string, resetCamera: boolean = true): Promise<void> {
        let map = this.mapsMap.get(mapId);
        if (!map) return Promise.reject(`There is no map with the id "${mapId}" loaded!`);

        if (this.playerMarkerManager) this.playerMarkerManager.dispose();
        if (this.markerFileManager) this.markerFileManager.dispose();

        await this.mapViewer.switchMap(map)

        if (resetCamera || !this.mapViewer.map.hasView(this.appState.controls.state))
            this.resetCamera();

        this.updatePageAddress();

        await Promise.all([
            this.initPlayerMarkerManager(),
            this.initMarkerFileManager(),
            this.initEventSource(),
        ]);
    }

    resetCamera(): void {
        let map = this.mapViewer.map;
        let controls = this.mapViewer.controlsManager;

        if (map) {
            let startX = map.data.startPos.x;
            let startZ = map.data.startPos.z;
            let terrainY = map.terrainHeightAt(startX, startZ);
            let startY = (typeof terrainY === "number" && !isNaN(terrainY)) ? terrainY + 1 : 69;
            controls.position.set(startX, startY, startZ);
            controls.distance = 1500;
            controls.angle = 0;
            controls.rotation = 0;
            controls.tilt = 0;
            controls.ortho = 0;
        }

        controls.controls = this.mapControls;
        this.appState.controls.state = "perspective";

        if (this.settings.defaultToFlatView && map.hasView("flat")) {
            this.setFlatView();
        }

        else if (!map.hasView("perspective")) {
            if (map.hasView("flat"))
                this.setFlatView();
            else
                this.setFreeFlight();
        }

        this.updatePageAddress();
    }

    /**
     * @returns Promise<BlueMapMap[]>
     */
    async loadMaps(): Promise<BlueMapMap[]> {
        let settings = this.settings;
        let maps: BlueMapMap[] = [];

        // create maps
        if (settings.maps !== undefined){
            let loadingPromises = settings.maps.map(mapId => {
                let map = new BlueMapMap(mapId, settings.mapDataRoot + "/" + mapId, settings.liveDataRoot + "/" + mapId, this.loadBlocker, this.mapViewer.events, this.settings.clientDecompression);
                maps.push(map);

                return map.loadSettings(this.mapViewer.revalidatedUrls)
                    .catch(error => {
                        alert(this.events, `Failed to load settings for map '${map.data.id}':` + error, "warning");
                    });
            })

            await Promise.all(loadingPromises);
        }

        // sort maps
        maps.sort((map1, map2) => {
            let sort = map1.data.sorting - map2.data.sorting;
            if (isNaN(sort)) return 0;
            return sort;
        });

        return maps;
    }

    async getSettings(): Promise<BlueMapSettings> {
        if (!this.settings){
            let loaded = await this.loadSettings();
            this.settings = {
                version: "?",
                useCookies: false,
                defaultToFlatView: false,
                resolutionDefault: 1.0,
                minZoomDistance: 5,
                maxZoomDistance: 100000,
                hiresSliderMax: 500,
                hiresSliderDefault: 100,
                hiresSliderMin: 0,
                lowresSliderMax: 7000,
                lowresSliderDefault: 2000,
                lowresSliderMin: 500,
                mapDataRoot: "maps",
                liveDataRoot: "maps",
                maps: [
                    "world",
                    "world_the_end",
                    "world_nether"
                ],
                scripts: [],
                styles: [],
                clientDecompression: false,
                ...loaded
            };
        }

        return this.settings;
    }

    /**
     * @returns {Promise<Object>}
     */
    loadSettings(): Promise<Partial<BlueMapSettings>> {
        return new Promise((resolve, reject) => {
            let loader = new RevalidatingFileLoader<Partial<BlueMapSettings>>();
            loader.setRevalidatedUrls(new Set()); // force no-cache requests
            loader.setResponseType("json");
            loader.load("settings.json",
                resolve,
                () => {},
                () => reject("Failed to load the settings.json!")
            );
        });
    }

    /**
     * @param map {BlueMapMap}
     * @returns {Promise<Object>}
     */
    loadPlayerData(map: BlueMapMap): Promise<PlayersFileData> {
        return new Promise((resolve, reject) => {
            let loader = new RevalidatingFileLoader<PlayersFileData>();
            loader.setRevalidatedUrls(new Set()); // force no-cache requests
            loader.setResponseType("json");
            loader.load(map.data.liveDataRoot + "/live/players.json",
                fileData => {
                    // BlueMapApp has no fileUrl, so this reads undefined (kept as in the original)
                    if (!fileData) reject(`Failed to parse '${(this as { fileUrl?: string }).fileUrl}'!`);
                    else resolve(fileData);
                },
                () => {},
                () => reject(`Failed to load '${(this as { fileUrl?: string }).fileUrl}'!`)
            )
        });
    }

    /**
     * BlueMap のライブ情報 (プレイヤーの位置、描き直したタイル、マーカーの変更) を受け始める。
     * WebSocket (/up/ws。server/utils/bluemap-live.ts) を先に試し、つながらないときは元の BlueMap と同じ SSE (live/sse) にする。
     * どちらもつながっていないあいだは、元のとおり 1 秒 (マーカーは 10 秒) ごとに取りに行く
     */
    initEventSource(): void {
        this.closeLive();

        const map = this.mapViewer.map;
        if (!map) return;

        if (typeof WebSocket !== "undefined") this.connectLiveSocket(map.data.id, 2000);
        else this.connectEventSource(map);
    }

    closeLive(): void {
        if (this.mapEventSource) {
            this.mapEventSource.close();
            this.mapEventSource = null;
        }
        if (this.liveRetryTimer) {
            clearTimeout(this.liveRetryTimer);
            this.liveRetryTimer = null;
        }
        if (this.liveSocket) {
            const socket = this.liveSocket;
            this.liveSocket = null;
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            socket.close();
        }
    }

    /** map が今見ている地図のままなら、ライブ情報を取りに行く側 (1 秒ごとの取りに行き) を止める / 戻す */
    private setPolling(on: boolean): void {
        if (on) {
            this.playerMarkerManager?.resumeAutoUpdates();
            this.markerFileManager?.resumeAutoUpdates();
        } else {
            this.playerMarkerManager?.pauseAutoUpdates();
            this.markerFileManager?.pauseAutoUpdates();
        }
    }

    /** SSE と WebSocket のどちらで届いても同じ処理 */
    private applyLiveEvent(map: BlueMapMap, event: string, data: string): void {
        if (event === "tile") {
            const parsed = JSON.parse(data);

            const mgr = parsed.lod > 0 ? map.lowresTileManager[parsed.lod - 1] : map.hiresTileManager;
            if (mgr && !mgr.unloaded) {
                const tilehash = hashTile(parsed.x, parsed.y);
                const tile = mgr.tiles.get(tilehash);
                if (tile && !tile.loading) {
                    tile.load(mgr.tileLoader, true);
                }
            }
        } else if (event === "player") {
            this.playerMarkerManager?.updateFromData(JSON.parse(data));
        } else if (event === "marker") {
            this.markerFileManager?.updateFromData(JSON.parse(data));
        }
    }

    private connectLiveSocket(mapId: string, retryMs: number): void {
        const socket = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/up/ws`);
        this.liveSocket = socket;
        let opened = false;

        socket.onopen = () => {
            opened = true;
            socket.send(JSON.stringify({ bluemap: mapId }));
        };
        socket.onmessage = ({ data }) => {
            const map = this.mapViewer.map;
            if (!map || map.data.id !== mapId || typeof data !== "string") return;
            let msg: { type?: string, map?: string, state?: string, event?: string, data?: string };
            try {
                msg = JSON.parse(data);
            } catch {
                return;
            }
            if (msg.type !== "bluemap" || msg.map !== mapId) return;
            if (msg.state === "open") {
                alert(this.events, "Connected to live WebSocket - disabling polling", "debug");
                retryMs = 2000;
                this.setPolling(false);
            } else if (msg.state === "error") {
                alert(this.events, "Live WebSocket has no BlueMap connection - enabling polling", "debug");
                this.setPolling(true);
            } else if (typeof msg.event === "string" && typeof msg.data === "string") {
                try {
                    this.applyLiveEvent(map, msg.event, msg.data);
                } catch (e) {
                    alert(this.events, `Failed to apply live ${msg.event} event: ${e}`, "debug");
                }
            }
        };
        socket.onclose = () => {
            if (this.liveSocket !== socket) return;
            this.liveSocket = null;
            this.setPolling(true);
            // 一度もつながらなかった (WebSocket を通さない経路など) ときは、元の BlueMap と同じ SSE にする
            if (!opened) {
                const map = this.mapViewer.map;
                if (map && map.data.id === mapId) this.connectEventSource(map);
                return;
            }
            alert(this.events, "Live WebSocket closed - enabling polling and reconnecting", "debug");
            this.liveRetryTimer = setTimeout(() => {
                this.liveRetryTimer = null;
                const map = this.mapViewer.map;
                if (map && map.data.id === mapId) this.connectLiveSocket(mapId, Math.min(retryMs * 2, 60000));
            }, retryMs);
        };
    }

    private connectEventSource(map: BlueMapMap): void {
        this.mapEventSource = new EventSource(map.data.liveDataRoot + "/live/sse");
        this.mapEventSource.addEventListener("error", () => {
            alert(this.events, "SSE event source error - enabling polling", "debug");
            this.setPolling(true);
        });
        this.mapEventSource.addEventListener("open", () => {
            alert(this.events, "Connected to SSE event source - disabling polling", "debug");
            this.setPolling(false);
        });

        for (const event of ["tile", "player", "marker"]) {
            this.mapEventSource.addEventListener(event, ({ data }) => this.applyLiveEvent(map, event, data));
        }
    }

    initPlayerMarkerManager(): Promise<void> {
        if (this.playerMarkerManager)
            this.playerMarkerManager.dispose()

        const map = this.mapViewer.map;
        if (!map) return;

        this.playerMarkerManager = new PlayerMarkerManager(
            this.mapViewer.markers,
            map.data.liveDataRoot + "/live/players.json",
            map.data.mapDataRoot + "/assets/playerheads/",
            this.events,
            true
        );
        this.playerMarkerManager.setAutoUpdateInterval(0);
        return this.playerMarkerManager.update()
            .then(() => {
                this.playerMarkerManager.setAutoUpdateInterval(1000);
            })
            .catch(e => {
                alert(this.events, e, "warning");
                this.playerMarkerManager.dispose();
            });
    }

    initMarkerFileManager(): Promise<void> {
        if (this.markerFileManager)
            this.markerFileManager.dispose();

        const map = this.mapViewer.map;
        if (!map) return;

        this.markerFileManager = new NormalMarkerManager(this.mapViewer.markers, map.data.liveDataRoot + "/live/markers.json", this.events, true);
        return this.markerFileManager.update()
            .then(() => {
                this.markerFileManager.setAutoUpdateInterval(1000 * 10);
            })
            .catch(e => {
                alert(this.events, e, "warning");
                this.markerFileManager.dispose();
            });
    }

    updateControlsSettings(): void {
        let mouseInvert = this.appState.controls.invertMouse ? -1 : 1;

        this.freeFlightControls.mouseRotate.speedCapture = -1.5 * this.appState.controls.mouseSensitivity;
        this.freeFlightControls.mouseAngle.speedCapture = -1.5 * this.appState.controls.mouseSensitivity * mouseInvert;
        this.freeFlightControls.mouseRotate.speedRight = -2 * this.appState.controls.mouseSensitivity;
        this.freeFlightControls.mouseAngle.speedRight = -2 * this.appState.controls.mouseSensitivity * mouseInvert;
    }

    initGeneralEvents(): void {
        //close menu on fullscreen
        document.addEventListener("fullscreenchange", evt => {
            if (document.fullscreenElement) {
                this.mainMenu.closeAll();
            }
        });
    }

    setPerspectiveView(transition: number = 0, minDistance: number = 5): void {
        if (!this.mapViewer.map) return;
        if (!this.mapViewer.map.data.perspectiveView) return;
        if (this.viewAnimation) this.viewAnimation.cancel();

        let cm = this.mapViewer.controlsManager;
        cm.controls = null;

        let startDistance = cm.distance;
        let targetDistance = Math.max(5, minDistance, startDistance);

        let startY = cm.position.y;
        let terrainH = this.mapViewer.map.terrainHeightAt(cm.position.x, cm.position.z);
        let groundY = (typeof terrainH === "number" && !isNaN(terrainH)) ? terrainH + 3 : (cm.position.y || 69);
        let targetY = MathUtils.lerp(groundY, 0, Math.min(1, targetDistance / 500));

        let startAngle = cm.angle;
        let targetAngle = Math.min(Math.PI / 2, startAngle, MapControls.getMaxPerspectiveAngleForDistance(targetDistance));

        let startOrtho = cm.ortho;
        let startTilt = cm.tilt;

        this.viewAnimation = animate(p => {
            let ep = EasingFunctions.easeInOutQuad(p);
            cm.position.y = MathUtils.lerp(startY, targetY, ep);
            cm.distance = MathUtils.lerp(startDistance, targetDistance, ep);
            cm.angle = MathUtils.lerp(startAngle, targetAngle, ep);
            cm.ortho = MathUtils.lerp(startOrtho, 0, p);
            cm.tilt = MathUtils.lerp(startTilt, 0, ep);
        }, transition, finished => {
            this.mapControls.reset();
            if (finished){
                cm.controls = this.mapControls;
                this.updatePageAddress();
            }
        });

        this.appState.controls.state = "perspective";
    }

    setFlatView(transition: number = 0, minDistance: number = 5): void {
        if (!this.mapViewer.map) return;
        if (!this.mapViewer.map.data.flatView) return;
        if (this.viewAnimation) this.viewAnimation.cancel();

        let cm = this.mapViewer.controlsManager;
        cm.controls = null;

        let startDistance = cm.distance;
        let targetDistance = Math.max(5, minDistance, startDistance);

        let startRotation = cm.rotation;
        let startAngle = cm.angle;
        let startOrtho = cm.ortho;
        let startTilt = cm.tilt;

        this.viewAnimation = animate(p => {
            let ep = EasingFunctions.easeInOutQuad(p);
            cm.distance = MathUtils.lerp(startDistance, targetDistance, ep);
            cm.rotation = MathUtils.lerp(startRotation, 0, ep);
            cm.angle = MathUtils.lerp(startAngle, 0, ep);
            cm.ortho = MathUtils.lerp(startOrtho, 1, p);
            cm.tilt = MathUtils.lerp(startTilt, 0, ep);
        }, transition, finished => {
            this.mapControls.reset();
            if (finished){
                cm.controls = this.mapControls;
                this.updatePageAddress();
            }
        });

        this.appState.controls.state = "flat";
    }

    setFreeFlightView(transition?: number, targetY?: number): void {
        this.setFreeFlight(transition, targetY);
    }

    setFreeFlight(transition: number = 0, targetY?: number): void {
        if (!this.mapViewer.map) return;
        if (!this.mapViewer.map.data.freeFlightView) return;
        if (this.viewAnimation) this.viewAnimation.cancel();

        let cm = this.mapViewer.controlsManager;
        cm.controls = null;

        let startDistance = cm.distance;

        let startY = cm.position.y;
        if (targetY === undefined) {
            let terrainH = this.mapViewer.map.terrainHeightAt(cm.position.x, cm.position.z);
            targetY = (typeof terrainH === "number" && !isNaN(terrainH)) ? terrainH + 3 : (startY || 69);
        }

        let startAngle = cm.angle;
        let targetAngle = Math.PI / 2;

        let startOrtho = cm.ortho;
        let startTilt = cm.tilt;

        this.viewAnimation = animate(p => {
            let ep = EasingFunctions.easeInOutQuad(p);
            cm.position.y = MathUtils.lerp(startY, targetY, ep);
            cm.distance = MathUtils.lerp(startDistance, 0, ep);
            cm.angle = MathUtils.lerp(startAngle, targetAngle, ep);
            cm.ortho = MathUtils.lerp(startOrtho, 0, Math.min(p * 2, 1));
            cm.tilt = MathUtils.lerp(startTilt, 0, ep);
        }, transition, finished => {
            if (finished){
                cm.controls = this.freeFlightControls;
                this.updatePageAddress();
            }
        });

        this.appState.controls.state = "free";
    }

    setChunkBorders(chunkBorders: boolean): void {
        this.mapViewer.data.uniforms.chunkBorders.value = chunkBorders;
    }

    setDebug(debug: boolean): void {
        this.appState.debug = debug;

        if (debug){
            this.mapViewer.stats.showPanel(0);
        } else {
            this.mapViewer.stats.showPanel(-1);
        }
    }

    setTheme(theme: string): void {
        this.appState.theme = theme;

        if (theme === "light") {
            this.mapViewer.rootElement.classList.remove("theme-dark");
            this.mapViewer.rootElement.classList.remove("theme-contrast");
            this.mapViewer.rootElement.classList.add("theme-light");
        }
        else if (theme === "dark") {
            this.mapViewer.rootElement.classList.remove("theme-light");
            this.mapViewer.rootElement.classList.remove("theme-contrast");
            this.mapViewer.rootElement.classList.add("theme-dark");
        }
        else if (theme === "contrast") {
            this.mapViewer.rootElement.classList.remove("theme-light");
            this.mapViewer.rootElement.classList.remove("theme-dark");
            this.mapViewer.rootElement.classList.add("theme-contrast");
        }
        else {
            this.mapViewer.rootElement.classList.remove("theme-light");
            this.mapViewer.rootElement.classList.remove("theme-dark");
            this.mapViewer.rootElement.classList.remove("theme-contrast");
        }
    }

    setScreenshotClipboard(clipboard: boolean): void {
        this.appState.screenshot.clipboard = clipboard;
    }

    async updateMap(): Promise<void> {
        try {
            this.mapViewer.clearTileCache();
            if (this.mapViewer.map) {
                await this.switchMap(this.mapViewer.map.data.id, false);
            }
            this.saveUserSettings();
        } catch (e) {
            alert(this.events, e, "error");
        }
    }

    resetSettings(): void {
        this.saveUserSetting("resetSettings", true);
        location.reload();
    }

    async loadUserSettings(): Promise<void> {
        if (!isNaN(this.settings.resolutionDefault)) this.mapViewer.data.superSampling = this.settings.resolutionDefault;
        if (!isNaN(this.settings.hiresSliderDefault)) this.mapViewer.data.loadedHiresViewDistance = this.settings.hiresSliderDefault;
        if (!isNaN(this.settings.lowresSliderDefault)) this.mapViewer.data.loadedLowresViewDistance = this.settings.lowresSliderDefault;

        if (!this.settings.useCookies) return;

        if (this.loadUserSetting("resetSettings", false)) {
            alert(this.events, "Settings reset!", "info");
            this.saveUserSettings();
            return;
        }

        // If it's a reload, we assume the user is troubleshooting and actually
        // wants to fully refresh the map.
        const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
        if (entry.type === "reload") {
            this.mapViewer.clearTileCache();
        }

        this.mapViewer.superSampling = this.loadUserSetting("superSampling", this.mapViewer.data.superSampling);
        this.mapViewer.data.loadedHiresViewDistance = this.loadUserSetting("hiresViewDistance", this.mapViewer.data.loadedHiresViewDistance);
        this.mapViewer.data.loadedLowresViewDistance = this.loadUserSetting("lowresViewDistance", this.mapViewer.data.loadedLowresViewDistance);
        this.mapViewer.updateLoadedMapArea();
        this.appState.controls.mouseSensitivity = this.loadUserSetting("mouseSensitivity", this.appState.controls.mouseSensitivity);
        this.appState.controls.invertMouse = this.loadUserSetting("invertMouse", this.appState.controls.invertMouse);
        this.appState.controls.pauseTileLoading = this.loadUserSetting("pauseTileLoading", this.appState.controls.pauseTileLoading);
        this.appState.controls.showZoomButtons = this.loadUserSetting("showZoomButtons", this.appState.controls.showZoomButtons);
        this.updateControlsSettings();
        this.setTheme(this.loadUserSetting("theme", this.appState.theme));
        this.setScreenshotClipboard(this.loadUserSetting("screenshotClipboard", this.appState.screenshot.clipboard));
        await setLanguage(this.loadUserSetting("lang", i18n.locale.value));
        this.setChunkBorders(this.loadUserSetting("chunkBorders", this.mapViewer.data.uniforms.chunkBorders.value))
        this.setDebug(this.loadUserSetting("debug", this.appState.debug));

        alert(this.events, "Settings loaded!", "info");
    }

    saveUserSettings(): void {
        if (!this.settings.useCookies) return;

        this.saveUserSetting("resetSettings", false);

        this.saveUserSetting("superSampling", this.mapViewer.data.superSampling);
        this.saveUserSetting("hiresViewDistance", this.mapViewer.data.loadedHiresViewDistance);
        this.saveUserSetting("lowresViewDistance", this.mapViewer.data.loadedLowresViewDistance);
        this.saveUserSetting("mouseSensitivity", this.appState.controls.mouseSensitivity);
        this.saveUserSetting("invertMouse", this.appState.controls.invertMouse);
        this.saveUserSetting("pauseTileLoading", this.appState.controls.pauseTileLoading);
        this.saveUserSetting("showZoomButtons", this.appState.controls.showZoomButtons);
        this.saveUserSetting("theme", this.appState.theme);
        this.saveUserSetting("screenshotClipboard", this.appState.screenshot.clipboard);
        this.saveUserSetting("lang", i18n.locale.value);
        this.saveUserSetting("chunkBorders", this.mapViewer.data.uniforms.chunkBorders.value);
        this.saveUserSetting("debug", this.appState.debug);

        alert(this.events, "Settings saved!", "info");
    }

    loadUserSetting<T>(key: string, defaultValue: T): T {
        let value = getLocalStorage("bluemap-" + key);

        if (value === undefined) return defaultValue;
        return value;
    }

    saveUserSetting(key: string, value: unknown): void {
        if (this.savedUserSettings.get(key) !== value){
            this.savedUserSettings.set(key, value);
            setLocalStorage("bluemap-" + key, value);
        }
    }

    cameraMoved = (): void => {
        if (this.hashUpdateTimeout) clearTimeout(this.hashUpdateTimeout);
        this.hashUpdateTimeout = setTimeout(this.updatePageAddress, 1500);
        this.lastCameraMove = Date.now();
    }

    loadBlocker = async (): Promise<void> => {
        if (!this.appState.controls.pauseTileLoading) return;

        let timeToWait: number;
        do {
            let timeSinceLastMove = Date.now() - this.lastCameraMove;
            timeToWait = 250 - timeSinceLastMove;
            if (timeToWait > 0) await this.sleep(timeToWait);
        } while (timeToWait > 0);
    }

    sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    updatePageAddress = (): void => {
        let hash = "#";

        if (this.mapViewer.map) {
            hash += this.mapViewer.map.data.id;

            let controls = this.mapViewer.controlsManager;
            hash += ":" + round(controls.position.x, 0);
            hash += ":" + round(controls.position.y, 0);
            hash += ":" + round(controls.position.z, 0);
            hash += ":" + round(controls.distance, 0);
            hash += ":" + round(controls.rotation, 2);
            hash += ":" + round(controls.angle, 2);
            hash += ":" + round(controls.tilt, 2);
            hash += ":" + round(controls.ortho, 0);
            hash += ":" + this.appState.controls.state;
        }

        history.replaceState(undefined, undefined, hash);

        document.title = i18n.t("pageTitle", {
            map: this.mapViewer.map ? this.mapViewer.map.data.name : "?",
            version: this.settings.version
        });
    }

    loadPageAddress = async (): Promise<boolean> => {
        let hash = window.location.hash?.substring(1) || this.settings.startLocation || "";
        let values = hash.split(":");

        // only world is provided
        if (values.length === 1 && (!this.mapViewer.map || this.mapViewer.map.data.id !== values[0])) {
            try {
                await this.switchMap(values[0]);
            } catch (e) {
                return false;
            }

            return true;
        }

        // load full location
        if (values.length !== 10) return false;

        let controls = this.mapViewer.controlsManager;
        controls.controls = null;

        if (!this.mapViewer.map || this.mapViewer.map.data.id !== values[0]) {
            try {
                await this.switchMap(values[0]);
            } catch (e) {
                return false;
            }
        }

        switch (values[9]) {
            case "flat" : this.setFlatView(0); break;
            case "free" : this.setFreeFlight(0, controls.position.y); break;
            default : this.setPerspectiveView(0); break;
        }

        let x = parseFloat(values[1]);
        let y = parseFloat(values[2]);
        let z = parseFloat(values[3]);
        let dist = parseFloat(values[4]);
        let rot = parseFloat(values[5]);
        let angle = parseFloat(values[6]);
        let tilt = parseFloat(values[7]);
        let ortho = parseFloat(values[8]);

        if (isNaN(x) || isNaN(y) || isNaN(z)) {
            x = this.mapViewer.map?.data.startPos.x ?? 0;
            y = 69;
            z = this.mapViewer.map?.data.startPos.z ?? 0;
        }
        if (isNaN(dist)) dist = 1500;
        if (isNaN(rot)) rot = 0;
        if (isNaN(angle)) angle = 0;
        if (isNaN(tilt)) tilt = 0;
        if (isNaN(ortho)) ortho = 0;

        controls.position.x = x;
        controls.position.y = y;
        controls.position.z = z;
        controls.distance = dist;
        controls.rotation = rot;
        controls.angle = angle;
        controls.tilt = tilt;
        controls.ortho = ortho;

        this.updatePageAddress();
        this.mapViewer.updateLoadedMapArea();

        return true;
    }

    mapInteraction = (event: CustomEvent<MapInteractionEventDetail>): void => {
        if (event.detail.data.doubleTap) {
            let cm = this.mapViewer.controlsManager;
            let pos = event.detail.hit?.point || event.detail.object?.getWorldPosition(new Vector3());
            if (!pos) return;

            let startDistance = cm.distance;
            let targetDistance = Math.max(startDistance * 0.25, 5);

            let startX = cm.position.x;
            let targetX = pos.x;

            let startZ = cm.position.z;
            let targetZ = pos.z;

            this.viewAnimation = animate(p => {
                let ep = EasingFunctions.easeInOutQuad(p);
                cm.distance = MathUtils.lerp(startDistance, targetDistance, ep);
                cm.position.x = MathUtils.lerp(startX, targetX, ep);
                cm.position.z = MathUtils.lerp(startZ, targetZ, ep);
            }, 500);
        }
    }

    takeScreenshot = (): void => {
        let link = document.createElement("a");
        link.download = "bluemap-screenshot.png";
        link.href = this.mapViewer.renderer.domElement.toDataURL('image/png');
        link.click();

        if (this.appState.screenshot.clipboard) {
            this.mapViewer.renderer.domElement.toBlob(blob => {
                // eslint-disable-next-line no-undef
                navigator.clipboard.write([new ClipboardItem({ ['image/png']: blob })]).catch(e => {
                    alert(this.events, "Failed to copy screenshot to clipboard: " + e, "error");
                });
            });
        }
    }

}
