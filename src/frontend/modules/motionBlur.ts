import { kute } from "../client";
import { setFrameEnd } from "./gameFpsLimit";

const OVERLAY_ID = "kuteMotionBlur";
const REFERENCE_FRAME_MS = 1000 / 60;
const MAX_RETENTION = 0.4;
const MIN_WEIGHT = 0.002;
const TURN_START = 0.2;
const TURN_FULL = 2;
const RAD_PER_COUNT = 0.0024;

const VERTEX = `#version 300 es
void main(){
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const accumulateShader = (gamma: string): string => `#version 300 es
precision highp float;
uniform sampler2D source;
out vec4 color;
void main(){
    ivec2 size = textureSize(source, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 c = texelFetch(source, ivec2(p.x, size.y - 1 - p.y), 0).rgb;
    color = vec4(pow(c, vec3(${gamma})), 1.0);
}`;

const presentShader = (gamma: string): string => `#version 300 es
precision highp float;
uniform sampler2D history;
out vec4 color;
void main(){
    color = vec4(pow(texelFetch(history, ivec2(gl_FragCoord.xy), 0).rgb, vec3(1.0 / ${gamma})), 1.0);
}`;

function clamp(value: number, min: number, max: number): number{
    return Math.min(max, Math.max(min, value));
}

function krunkerSetting(key: string, fallback: number): number{
    const value = parseFloat(localStorage.getItem("kro_setngss_" + key) ?? "");
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram | null{
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const){
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

class MotionBlur {
    enabled = false;
    running = false;
    moveX = 0;
    moveY = 0;
    scaleX = 0;
    scaleY = 0;
    weight = 0;
    lastFrame = 0;
    hasHistory = false;
    game: HTMLCanvasElement | null = null;
    overlay: HTMLCanvasElement | null = null;
    gl: WebGL2RenderingContext | null = null;
    accumulate: WebGLProgram | null = null;
    present: WebGLProgram | null = null;
    source: WebGLTexture | null = null;
    history: WebGLTexture | null = null;
    historyBuffer: WebGLFramebuffer | null = null;
    historyFormat = 0;
    unsupported = false;
    onMouseMove = (event: MouseEvent): void => {
        if (document.pointerLockElement === null) return;
        this.moveX += event.movementX;
        this.moveY += event.movementY;
        if (!this.running){
            this.running = true;
            this.lastFrame = 0;
            this.readScale();
            setFrameEnd(this.onFrameEnd);
        }
    };
    onPointerLockChange = (): void => this.stop();
    onFrameEnd = (timestamp: number): void => this.frame(timestamp);
    onContextLost = (): void => this.release();

    constructor(){
        kute.settings.toggleMotionBlur = (enabled): void => this.toggle(enabled);
        this.toggle(!!kute.settings.data.motionBlur);
    }

    toggle(enabled: boolean): void{
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        if (enabled){
            window.addEventListener("mousemove", this.onMouseMove, true);
            document.addEventListener("pointerlockchange", this.onPointerLockChange);
            return;
        }
        window.removeEventListener("mousemove", this.onMouseMove, true);
        document.removeEventListener("pointerlockchange", this.onPointerLockChange);
        this.stop();
        this.unsupported = false;
        this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
        this.release();
        this.game = null;
    }

    stop(): void{
        if (this.running) setFrameEnd(null);
        this.running = false;
        this.moveX = 0;
        this.moveY = 0;
        this.weight = 0;
        this.hasHistory = false;
        if (this.overlay) this.overlay.style.display = "none";
    }

    release(): void{
        this.overlay?.removeEventListener("webglcontextlost", this.onContextLost);
        this.overlay?.remove();
        this.overlay = null;
        this.gl = null;
        this.accumulate = null;
        this.present = null;
        this.source = null;
        this.history = null;
        this.historyBuffer = null;
        this.hasHistory = false;
    }

    readScale(): void{
        const fov = clamp(krunkerSetting("fov", 100), 10, 170) * Math.PI / 180;
        const heightsPerRad = 0.5 / Math.tan(fov / 2);
        this.scaleX = RAD_PER_COUNT * krunkerSetting("sensitivityX", 1) * heightsPerRad;
        this.scaleY = RAD_PER_COUNT * krunkerSetting("sensitivityY", 1) * heightsPerRad;
    }

    createContext(): boolean{
        const overlay = document.createElement("canvas");
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;contain:strict;display:none";
        const gl = overlay.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
        if (!gl) return false;

        const float = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
        const gamma = float ? "2.2" : "1.0";
        const accumulate = compile(gl, accumulateShader(gamma));
        const present = compile(gl, presentShader(gamma));
        if (!accumulate || !present) return false;

        gl.useProgram(accumulate);
        gl.uniform1i(gl.getUniformLocation(accumulate, "source"), 0);
        gl.useProgram(present);
        gl.uniform1i(gl.getUniformLocation(present, "history"), 1);

        const source = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        const history = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, history);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        const historyBuffer = gl.createFramebuffer();
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);

        overlay.addEventListener("webglcontextlost", this.onContextLost);
        this.overlay = overlay;
        this.gl = gl;
        this.accumulate = accumulate;
        this.present = present;
        this.source = source;
        this.history = history;
        this.historyBuffer = historyBuffer;
        this.historyFormat = float ? gl.RGBA16F : gl.RGBA8;
        return true;
    }

    attach(): boolean{
        if (!this.game?.isConnected) this.game = document.querySelector("body > canvas:not([id])");
        const { game } = this;
        if (!game) return false;
        if (!this.overlay && (this.unsupported || !this.createContext())){
            this.unsupported = true;
            return false;
        }
        const { overlay, gl } = this;
        if (!overlay || !gl) return false;
        if (overlay.previousElementSibling !== game) game.after(overlay);
        if (overlay.width !== game.width || overlay.height !== game.height){
            overlay.width = game.width;
            overlay.height = game.height;
            gl.viewport(0, 0, game.width, game.height);
            gl.activeTexture(gl.TEXTURE1);
            gl.texImage2D(gl.TEXTURE_2D, 0, this.historyFormat, game.width, game.height, 0, gl.RGBA, this.historyFormat === gl.RGBA8 ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.historyBuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.history, 0);
            this.hasHistory = false;
        }
        return true;
    }

    frame(timestamp: number): void{
        const delta = this.lastFrame ? clamp(timestamp - this.lastFrame, 1, 100) : REFERENCE_FRAME_MS;
        this.lastFrame = timestamp;

        const turn = Math.hypot(this.moveX * this.scaleX, this.moveY * this.scaleY) * (1000 / delta);
        this.moveX = 0;
        this.moveY = 0;
        const amount = clamp((turn - TURN_START) / (TURN_FULL - TURN_START), 0, 1);
        const strength = clamp(Number(kute.settings.data.motionBlurStrength) || 0, 0, 100) / 100;
        const target = strength * MAX_RETENTION * amount * amount * (3 - 2 * amount);
        this.weight += (target - this.weight) * (1 - Math.exp(-delta / (target > this.weight ? 6 : 12)));

        if (this.weight < MIN_WEIGHT){
            this.stop();
            return;
        }
        if (!this.attach() || !this.overlay || !this.gl || !this.game){
            this.stop();
            return;
        }

        const { gl, overlay, game } = this;
        gl.activeTexture(gl.TEXTURE0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, game);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.historyBuffer);
        gl.useProgram(this.accumulate);
        if (this.hasHistory){
            gl.enable(gl.BLEND);
            gl.blendColor(0, 0, 0, 1 - this.weight ** (delta / REFERENCE_FRAME_MS));
        }
        else gl.disable(gl.BLEND);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(this.present);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        if (!this.hasHistory){
            this.hasHistory = true;
            overlay.style.filter = game.style.filter;
            overlay.style.display = "block";
        }
    }
}

export default new MotionBlur();
