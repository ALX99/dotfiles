// Cursor Blaze
//
// A coronal cursor treatment that complements Stellar Dynamics:
//   - a shrinking white-blue cursor comet
//   - photospheric-white sparks on cursor movement
//   - a cool corona aura and restrained refraction
//   - faint scanlines and a vignette
//
// Ghostty exposes the terminal as iChannel0 and supplies cursor uniforms.

#define PI 3.14159265358979323846

// These complement stellar-drift.glsl: a cool white corona around a slightly
// warmer stellar core.
const vec3 DEEP_NAVY = vec3(0.012, 0.027, 0.058);
const vec3 CORONAL_BLUE = vec3(0.320, 0.600, 0.940);
const vec3 CORONA_WHITE = vec3(0.720, 0.850, 1.000);
const vec3 PHOTOSPHERE_WHITE = vec3(1.000, 0.940, 0.700);

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
    along = saturate(dot(point - start, segment) / max(dot(segment, segment), 0.0001));
    return length(point - (start + segment * along));
}

float roundedBoxDistance(vec2 point, vec2 center, vec2 halfSize, float radius)
{
    vec2 distanceToEdge = abs(point - center) - halfSize + radius;
    return length(max(distanceToEdge, 0.0))
        + min(max(distanceToEdge.x, distanceToEdge.y), 0.0)
        - radius;
}

vec3 terminalEmission(vec2 uv, vec2 offset, vec3 background)
{
    vec3 sampleColor = texture(iChannel0, clamp(uv + offset, 0.0, 1.0)).rgb;
    float ink = smoothstep(0.08, 0.70, length(sampleColor - background));
    return max(sampleColor - background, 0.0) * ink;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 resolution = iResolution.xy;
    vec2 uv = fragCoord / resolution;
    vec2 pixel = 1.0 / resolution;
    vec4 source = texture(iChannel0, uv);
    vec3 color = source.rgb;

    vec2 current = cursorCenter(iCurrentCursor);
    vec2 previous = cursorCenter(iPreviousCursor);
    vec2 movement = current - previous;
    float movementLength = length(movement);
    float cellSize = max(max(iCurrentCursor.z, iCurrentCursor.w), 1.0);
    float cursorAge = max(iTime - iTimeCursorChange, 0.0);

    // Bloom only has a visible effect on background pixels. Four nearby
    // samples retain the soft text halo while avoiding eight fetches on every
    // pixel (and all fetches over glyph interiors).
    float backgroundMask = 1.0
        - smoothstep(0.025, 0.16, length(source.rgb - iBackgroundColor));
    if (backgroundMask > 0.001) {
        vec2 bloomOffset = pixel * 1.5;
        vec3 bloom = vec3(0.0);
        bloom += terminalEmission(uv, vec2(bloomOffset.x, 0.0), iBackgroundColor);
        bloom += terminalEmission(uv, vec2(-bloomOffset.x, 0.0), iBackgroundColor);
        bloom += terminalEmission(uv, vec2(0.0, bloomOffset.y), iBackgroundColor);
        bloom += terminalEmission(uv, vec2(0.0, -bloomOffset.y), iBackgroundColor);
        color += bloom * 0.018;
    }

    // Pull the old end of the trail towards the new cursor. Short movements
    // disappear quickly, while longer jumps linger just enough to stay
    // readable.
    float movementCells = movementLength / cellSize;
    float trailLifetime = mix(0.30, 0.52, smoothstep(0.5, 10.0, movementCells));
    float trailProgress = smootherstep(cursorAge / trailLifetime);
    float trailAlive = 1.0 - smoothstep(trailLifetime * 0.58, trailLifetime, cursorAge);
    float movementGate = smoothstep(cellSize * 0.20, cellSize * 0.90, movementLength);
    bool movementActive = movementGate * trailAlive > 0.001;
    if (movementActive) {
        vec2 trailStart = mix(previous, current, trailProgress);
        float along;
        float trailDistance = segmentDistance(fragCoord, trailStart, current, along);
        float trailWidth = cellSize * mix(0.38, 0.16, trailProgress);

        // Taper and dim the old end so the trail reads as a comet rather than
        // a uniformly thick beam.
        float trailTaper = mix(0.28, 1.0, smootherstep(along));
        float localTrailWidth = trailWidth * trailTaper;
        float tailFade = mix(0.20, 1.0, smootherstep(along));
        float trailCore = 1.0
            - smoothstep(
                localTrailWidth * 0.12,
                localTrailWidth * 0.55,
                trailDistance
            );
        float trailBeam = 1.0
            - smoothstep(
                localTrailWidth * 0.45,
                localTrailWidth * 1.50,
                trailDistance
            );
        float trailAura = 1.0
            - smoothstep(
                localTrailWidth,
                localTrailWidth * 4.5,
                trailDistance
            );
        float shimmer = 0.90 + 0.10 * sin(along * 18.0 - iTime * 9.0);
        vec3 trailColor = mix(CORONAL_BLUE, CORONA_WHITE, smootherstep(along));
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

    // A few deterministic particles split gently away from the beam. The
    // cursor-change timestamp acts as a stable random seed for each movement.
    float sparkLife = 1.0 - smoothstep(0.12, 0.48, cursorAge);
    if (movementGate * sparkLife > 0.001) {
        vec2 direction = movement / max(movementLength, 0.0001);
        vec2 normal = vec2(-direction.y, direction.x);
        float eventSeed = floor(iTimeCursorChange * 120.0);
        for (int index = 0; index < 5; index++) {
            float id = float(index);
            float seedA = hash11(eventSeed + id * 17.17);
            float seedB = hash11(eventSeed + id * 41.73 + 9.2);
            float seedC = hash11(eventSeed + id * 73.91 + 2.8);
            vec2 sparkPosition = mix(previous, current, seedA);
            sparkPosition += normal
                * (seedB - 0.5)
                * cursorAge
                * (28.0 + 52.0 * seedC);
            sparkPosition -= direction * cursorAge * (8.0 + 22.0 * seedA);
            float sparkRadius = mix(2.2, 0.45, saturate(cursorAge / 0.48));
            float spark = 1.0
                - smoothstep(
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

    // The corona occupies only a small rectangle around the cursor. Avoid its
    // signed-distance calculation for the rest of the full-screen pass.
    vec2 cursorHalfSize = max(iCurrentCursor.zw * 0.5, vec2(0.75));
    vec2 cursorDelta = fragCoord - current;
    vec2 absCursorDelta = abs(cursorDelta);
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

    // Locally split RGB channels near an active trail. The cool coronal
    // fringe stays visible while moving but disappears while reading output.
    if (
        movementActive
            && max(absCursorDelta.x, absCursorDelta.y) < 150.0
    ) {
        float radialDistance = length(cursorDelta);
        float prismMask = trailAlive
            * movementGate
            * (1.0 - smoothstep(20.0, 150.0, radialDistance))
            * 0.30;
        if (prismMask > 0.001) {
            vec2 prismOffset = cursorDelta
                / max(radialDistance, 1.0)
                * pixel
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
            color = mix(color, refracted + (color - source.rgb), prismMask);
        }
    }

    // A nearly invisible energy ripple in background pixels makes the cursor
    // feel luminous without tinting text.
    if (
        backgroundMask > 0.001
            && max(absCursorDelta.x, absCursorDelta.y) < 330.0
    ) {
        float radialDistance = length(cursorDelta);
        if (radialDistance < 330.0) {
            float angle = atan(cursorDelta.y, cursorDelta.x);
            float ripple = 0.5
                + 0.5
                    * sin(radialDistance * 0.055 - iTime * 2.2 + angle * 3.0);
            float ambient = (1.0 - smoothstep(20.0, 330.0, radialDistance))
                * ripple
                * backgroundMask;
            color += mix(DEEP_NAVY, CORONAL_BLUE, ripple) * ambient * 0.012;
        }
    }

    // Finish with faint moving scanlines and a soft vignette.
    float scanline = 0.5 + 0.5 * sin(fragCoord.y * PI + iTime * 2.0);
    color *= 0.986 + scanline * 0.014;
    vec2 vignetteUv = uv * (1.0 - uv.yx);
    float vignette = pow(saturate(vignetteUv.x * vignetteUv.y * 18.0), 0.10);
    color *= mix(0.90, 1.0, vignette);

    fragColor = vec4(clamp(color, 0.0, 1.0), source.a);
}
