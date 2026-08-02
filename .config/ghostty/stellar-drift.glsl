// STELLAR DRIFT
//
// A single-pass deep-space background for Ghostty. Cursor Blaze is fused into
// this shader so Ghostty avoids an intermediate full-screen texture pass.
// It retains the diffuse Milky Way, stable stars, cursor corona, motion trail,
// rare shooting stars, and gentle drift with low idle GPU cost.
//
// The terminal remains authoritative: its RGB and alpha are preserved for
// terminal content.

#define PI 3.14159265358979323846

const vec3 DEEP_NAVY = vec3(0.012, 0.027, 0.058);
const vec3 CORONAL_BLUE = vec3(0.320, 0.600, 0.940);
const vec3 CORONA_WHITE = vec3(0.720, 0.850, 1.000);
const vec3 PHOTOSPHERE_WHITE = vec3(1.000, 0.940, 0.700);

const vec3 SPACE_BLACK = vec3(0.0010, 0.0020, 0.0060);
const vec3 DEEP_BLUE = vec3(0.006, 0.017, 0.050);
const vec3 NEBULA_VIOLET = vec3(0.070, 0.018, 0.145);
const vec3 NEBULA_CYAN = vec3(0.008, 0.085, 0.155);
const vec3 STAR_COLD = vec3(0.520, 0.760, 1.000);
const vec3 STAR_WARM = vec3(1.000, 0.680, 0.380);

float saturate(float value)
{
    return clamp(value, 0.0, 1.0);
}

float hash11(float value)
{
    value = fract(value * 0.1031);
    value *= value + 33.33;
    value *= value + value;
    return fract(value);
}

float hash21(vec2 value)
{
    vec3 p3 = fract(vec3(value.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// The band needs variation along its length, not a full 2D cloud simulation.
// Two scalar hashes replace the former two octaves of 2D value noise.
float bandNoise(float value)
{
    float cell = floor(value);
    float local = fract(value);
    local = local * local * (3.0 - 2.0 * local);
    return mix(hash11(cell), hash11(cell + 1.0), local);
}

// Each cell has at most one finite, soft star. Empty cells return before any
// position, colour, or edge work; cells are large enough for that branch to
// remain coherent across neighbouring fragments.
vec3 starLayer(
    vec2 fragCoord,
    float spacing,
    float threshold,
    float seed,
    float intensity
)
{
    vec2 grid = fragCoord / spacing;
    vec2 cell = floor(grid);
    float identity = hash21(cell + seed);
    if (identity < threshold) {
        return vec3(0.0);
    }

    float positionSeed = fract(identity * 57.583);
    vec2 position = vec2(
        fract(identity * 19.193),
        fract(positionSeed * 23.197)
    ) * 0.68 + 0.16;
    vec2 delta = (fract(grid) - position) * spacing;
    float radius = mix(0.34, 1.14, positionSeed * positionSeed);
    float radiusSquared = radius * radius;
    float core = 1.0 - smoothstep(
        radiusSquared,
        radiusSquared * 4.0,
        dot(delta, delta)
    );
    vec3 colour = mix(
        STAR_WARM,
        STAR_COLD,
        fract(identity * 41.371)
    );
    float luminosity = mix(0.30, 0.90, fract(identity * 7.131));

    return colour * core * intensity * luminosity;
}

float segmentDistanceSquared(
    vec2 point,
    vec2 start,
    vec2 end,
    out float along
)
{
    vec2 segment = end - start;
    along = saturate(
        dot(point - start, segment) / max(dot(segment, segment), 0.0001)
    );
    vec2 delta = point - (start + segment * along);
    return dot(delta, delta);
}

// Meteor geometry is evaluated only during the active portion of a successful
// cycle. Polynomial edges replace the former exponential trail and glow.
vec3 shootingStar(vec2 point)
{
    const float CYCLE_SECONDS = 17.0;
    float cycle = floor(iTime / CYCLE_SECONDS);
    float phase = fract(iTime / CYCLE_SECONDS);
    float eventSeed = hash11(cycle * 13.17 + 4.1);
    if (eventSeed <= 0.63 || phase <= 0.11 || phase >= 0.54) {
        return vec3(0.0);
    }

    float life = smoothstep(0.11, 0.17, phase)
        * (1.0 - smoothstep(0.40, 0.54, phase))
        * smoothstep(0.63, 0.82, eventSeed);
    float travel = saturate((phase - 0.11) / 0.38);
    vec2 start = vec2(
        mix(-0.76, 0.36, hash11(cycle * 7.1 + 2.3)),
        mix(0.30, 0.72, hash11(cycle * 11.7 + 8.4))
    );
    vec2 direction = vec2(
        mix(0.58, 0.92, hash11(cycle * 3.7 + 6.2)),
        mix(-0.64, -0.36, hash11(cycle * 17.9 + 1.3))
    );
    direction *= inversesqrt(dot(direction, direction));
    vec2 head = start + direction * travel * 1.18;
    vec2 tailStart = head - direction * mix(
        0.10,
        0.24,
        hash11(cycle * 5.9 + 9.7)
    );
    float along;
    float trailDistanceSquared = segmentDistanceSquared(
        point,
        tailStart,
        head,
        along
    );
    float trailWidth = mix(0.0020, 0.0065, 1.0 - along);
    float trailWidthSquared = trailWidth * trailWidth;
    float trail = (1.0 - smoothstep(
        trailWidthSquared,
        trailWidthSquared * 12.0,
        trailDistanceSquared
    )) * along * along;
    vec2 headDelta = point - head;
    float headGlow = 1.0 - smoothstep(
        0.000012,
        0.000100,
        dot(headDelta, headDelta)
    );
    vec3 colour = mix(
        STAR_COLD,
        STAR_WARM,
        hash11(cycle * 19.3 + 2.7)
    );

    return colour * life * (trail * 0.72 + headGlow * 1.18);
}

float smootherstep(float value)
{
    value = saturate(value);
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
}

vec2 cursorCenter(vec4 cursor)
{
    return vec2(cursor.x + cursor.z * 0.5, cursor.y - cursor.w * 0.5);
}

float segmentDistance(vec2 point, vec2 start, vec2 end, out float along)
{
    vec2 segment = end - start;
    along = saturate(
        dot(point - start, segment) / max(dot(segment, segment), 0.0001)
    );
    return length(point - (start + segment * along));
}

float roundedBoxDistance(vec2 point, vec2 center, vec2 halfSize, float radius)
{
    vec2 distanceToEdge = abs(point - center) - halfSize + radius;
    return length(max(distanceToEdge, 0.0))
        + min(max(distanceToEdge.x, distanceToEdge.y), 0.0)
        - radius;
}

// Cursor Blaze is fused here so the terminal texture is sampled and written
// once per frame rather than being passed through a separate full-screen pass.
vec3 cursorBlaze(vec3 source, vec2 uv, vec2 fragCoord, vec2 resolution)
{
    vec3 color = source;
    vec2 current = cursorCenter(iCurrentCursor);
    vec2 previous = cursorCenter(iPreviousCursor);
    vec2 cursorDelta = fragCoord - current;
    vec2 absCursorDelta = abs(cursorDelta);
    float cursorAge = max(iTime - iTimeCursorChange, 0.0);
    float movementGate = 0.0;
    float trailAlive = 0.0;
    bool movementActive = false;

    // Cursor movement effects are finished within 0.52 seconds. The uniform
    // age check skips all trail and particle setup while reading.
    vec2 movement = current - previous;
    if (cursorAge < 0.52 && dot(movement, movement) > 0.0) {
        float movementLength = length(movement);
        float cellSize = max(max(iCurrentCursor.z, iCurrentCursor.w), 1.0);
        movementGate = smoothstep(
            cellSize * 0.20,
            cellSize * 0.90,
            movementLength
        );
        float trailLifetime = mix(
            0.30,
            0.52,
            smoothstep(0.5, 10.0, movementLength / cellSize)
        );
        float trailProgress = smootherstep(cursorAge / trailLifetime);
        trailAlive = 1.0 - smoothstep(
            trailLifetime * 0.58,
            trailLifetime,
            cursorAge
        );
        movementActive = movementGate * trailAlive > 0.001;
        float sparkLife = 1.0 - smoothstep(0.12, 0.48, cursorAge);
        bool sparksActive = movementGate * sparkLife > 0.001;

        if (movementActive || sparksActive) {
            vec2 trailStart = mix(previous, current, trailProgress);
            float effectPadding = cellSize * 2.0 + 48.0;
            vec2 effectLower = min(previous, current) - vec2(effectPadding);
            vec2 effectUpper = max(previous, current) + vec2(effectPadding);
            if (
                all(greaterThan(fragCoord, effectLower))
                    && all(lessThan(fragCoord, effectUpper))
            ) {
                if (movementActive) {
                    float along;
                    float trailDistance = segmentDistance(
                        fragCoord,
                        trailStart,
                        current,
                        along
                    );
                    float trailWidth = cellSize * mix(0.38, 0.16, trailProgress);
                    float trailTaper = mix(0.28, 1.0, smootherstep(along));
                    float localTrailWidth = trailWidth * trailTaper;
                    float tailFade = mix(0.20, 1.0, smootherstep(along));
                    float trailCore = 1.0 - smoothstep(
                        localTrailWidth * 0.12,
                        localTrailWidth * 0.55,
                        trailDistance
                    );
                    float trailBeam = 1.0 - smoothstep(
                        localTrailWidth * 0.45,
                        localTrailWidth * 1.50,
                        trailDistance
                    );
                    float trailAura = 1.0 - smoothstep(
                        localTrailWidth,
                        localTrailWidth * 4.5,
                        trailDistance
                    );
                    float shimmer = 0.90 + 0.10 * sin(
                        along * 18.0 - iTime * 9.0
                    );
                    vec3 trailColor = mix(
                        CORONAL_BLUE,
                        CORONA_WHITE,
                        smootherstep(along)
                    );
                    trailColor = mix(
                        trailColor,
                        PHOTOSPHERE_WHITE,
                        0.18 * sin(along * PI)
                    );
                    color += trailColor
                        * (trailCore * 0.78 + trailBeam * 0.25 + trailAura * 0.10)
                        * trailAlive
                        * tailFade
                        * shimmer;
                }

                if (sparksActive) {
                    vec2 direction = movement / movementLength;
                    vec2 normal = vec2(-direction.y, direction.x);
                    float eventSeed = floor(iTimeCursorChange * 120.0);
                    for (int index = 0; index < 5; index++) {
                        float id = float(index);
                        float seedA = hash11(eventSeed + id * 17.17);
                        float seedB = hash11(eventSeed + id * 41.73 + 9.2);
                        float seedC = hash11(eventSeed + id * 73.91 + 9.2);
                        vec2 sparkPosition = mix(previous, current, seedA);
                        sparkPosition += normal
                            * (seedB - 0.5)
                            * cursorAge
                            * (28.0 + 52.0 * seedC);
                        sparkPosition -= direction * cursorAge * (8.0 + 22.0 * seedA);
                        float sparkRadius = mix(
                            2.2,
                            0.45,
                            saturate(cursorAge / 0.48)
                        );
                        float spark = 1.0 - smoothstep(
                            sparkRadius * 0.25,
                            sparkRadius,
                            distance(fragCoord, sparkPosition)
                        );
                        float twinkle = 0.78 + 0.22 * sin(iTime * 18.0 + id * 3.1);
                        color += mix(CORONA_WHITE, PHOTOSPHERE_WHITE, seedB)
                            * spark
                            * sparkLife
                            * movementGate
                            * twinkle
                            * 0.72;
                    }
                }
            }
        }
    }

    // The corona occupies only a small rectangle around the cursor.
    vec2 cursorHalfSize = max(iCurrentCursor.zw * 0.5, vec2(0.75));
    if (all(lessThan(absCursorDelta, cursorHalfSize + vec2(20.0)))) {
        float cursorDistance = roundedBoxDistance(
            fragCoord,
            current,
            cursorHalfSize,
            min(2.5, min(cursorHalfSize.x, cursorHalfSize.y))
        );
        float cursorOutside = step(0.0, cursorDistance);
        float cursorAura = (1.0 - smoothstep(0.0, 18.0, cursorDistance))
            * cursorOutside;
        float cursorEdge = 1.0 - smoothstep(0.2, 1.8, abs(cursorDistance));
        float heartbeat = 0.86 + 0.14 * sin(iTime * 4.0);
        color += CORONA_WHITE * cursorAura * 0.11 * heartbeat;
        color += mix(CORONA_WHITE, PHOTOSPHERE_WHITE, 0.45)
            * cursorEdge
            * 0.30;
    }

    if (movementActive && max(absCursorDelta.x, absCursorDelta.y) < 150.0) {
        float radialDistance = length(cursorDelta);
        float prismMask = trailAlive
            * movementGate
            * (1.0 - smoothstep(20.0, 150.0, radialDistance))
            * 0.30;
        if (prismMask > 0.001) {
            vec2 prismOffset = cursorDelta
                / max(radialDistance, 1.0)
                / resolution
                * 1.35;
            vec3 refracted = color;
            refracted.r = texture(
                iChannel0,
                clamp(uv + prismOffset, 0.0, 1.0)
            ).r;
            refracted.b = texture(
                iChannel0,
                clamp(uv - prismOffset, 0.0, 1.0)
            ).b;
            color = mix(color, refracted + (color - source), prismMask);
        }
    }

    if (max(absCursorDelta.x, absCursorDelta.y) < 330.0) {
        vec3 backgroundDelta = source - iBackgroundColor;
        float backgroundMask = 1.0 - smoothstep(
            0.000625,
            0.025600,
            dot(backgroundDelta, backgroundDelta)
        );
        if (backgroundMask > 0.001) {
            float radialDistance = length(cursorDelta);
            if (radialDistance < 330.0) {
                float angle = atan(cursorDelta.y, cursorDelta.x);
                float ripple = 0.5
                    + 0.5
                        * sin(
                            radialDistance * 0.055 - iTime * 2.2 + angle * 3.0
                        );
                float ambient = (1.0 - smoothstep(
                    20.0,
                    330.0,
                    radialDistance
                )) * ripple * backgroundMask;
                color += mix(DEEP_NAVY, CORONAL_BLUE, ripple) * ambient * 0.012;
            }
        }
    }

    return clamp(color, 0.0, 1.0);
}

// Raw terminal pixels need a much lower threshold than cursor effects: it
// preserves antialiased glyph edges before the generated scene is composited.
float terminalContent(vec3 colour)
{
    vec3 delta = colour - iBackgroundColor;
    return smoothstep(0.000025, 0.000400, dot(delta, delta));
}

// Cursor Blaze is evaluated before terminal ink classification so the cursor
// effect remains visible while the terminal itself stays authoritative.
float terminalInk(vec3 colour)
{
    float backgroundEnergy = max(
        dot(iBackgroundColor, iBackgroundColor),
        0.0001
    );
    float backgroundScale = dot(colour, iBackgroundColor)
        / backgroundEnergy;
    vec3 delta = colour - iBackgroundColor * backgroundScale;
    float chromaInk = smoothstep(0.000144, 0.003600, dot(delta, delta));
    float brightnessInk = smoothstep(
        0.14,
        0.26,
        abs(backgroundScale - 1.0)
    );
    return max(chromaInk, brightnessInk);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 resolution = iResolution.xy;
    vec2 uv = fragCoord / resolution;
    vec4 source = texture(iChannel0, uv);
    vec3 cursorColour = cursorBlaze(source.rgb, uv, fragCoord, resolution);
    float ink = max(terminalContent(source.rgb), terminalInk(cursorColour));
    if (ink >= 1.0) {
        fragColor = vec4(cursorColour, source.a);
        return;
    }

    vec2 point = (fragCoord - resolution * 0.5) / resolution.y;
    // rotation(-0.22), with constant sine and cosine already folded in.
    vec2 nebulaPoint = vec2(
        point.x * 0.975897 + point.y * -0.218230,
        point.x * 0.218230 + point.y * 0.975897
    );
    float gas = bandNoise(
        nebulaPoint.x * 2.8
            + nebulaPoint.y * 0.65
            + iTime * 0.0022
    );
    float bandAxis = nebulaPoint.y
        + nebulaPoint.x * 0.28
        - 0.010
        + (gas - 0.50) * 0.18;
    float milkyWay = 1.0 - smoothstep(0.055, 0.46, abs(bandAxis));
    float dustLane = 1.0 - smoothstep(
        0.007,
        0.055,
        abs(bandAxis + (gas - 0.50) * 0.045)
    );

    vec3 scene = SPACE_BLACK;
    scene += DEEP_BLUE * (0.10 + gas * 0.18);
    scene += mix(NEBULA_VIOLET, NEBULA_CYAN, gas)
        * milkyWay
        * (0.150 + gas * 0.270);
    scene *= 1.0 - dustLane * milkyWay * 0.24;
    vec2 coreOffset = nebulaPoint - vec2(-0.26, 0.12);
    float galacticCore = 1.0 - smoothstep(
        0.05,
        0.45,
        dot(coreOffset * vec2(1.0, 1.55), coreOffset * vec2(1.0, 1.55))
    );
    scene += mix(NEBULA_VIOLET, NEBULA_CYAN, gas)
        * galacticCore
        * (0.030 + gas * 0.045);

    // One low-cost global pulse keeps the field alive without a sine per star.
    float twinklePhase = fract(iTime * 0.08);
    float twinkle = 0.95 + 0.05
        * (1.0 - abs(twinklePhase * 2.0 - 1.0));
    scene += (
        starLayer(fragCoord, 22.0, 0.860, 3.2, 0.84)
    ) * twinkle;
    scene += shootingStar(point);

    float vignette = saturate(
        1.0 - dot(point * vec2(0.45, 0.70), point * vec2(0.45, 0.70))
    );
    scene *= mix(0.84, 1.0, vignette);

    vec3 colour = mix(scene, cursorColour, ink);
    fragColor = vec4(clamp(colour, 0.0, 1.0), source.a);
}
