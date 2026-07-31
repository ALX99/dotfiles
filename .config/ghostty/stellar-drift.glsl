// STELLAR DRIFT
//
// A deliberately lightweight deep-space background for Ghostty:
//   - a low-contrast Milky Way dust band and stable multiscale star field
//   - rare, analytic shooting stars with short luminous tails
//   - continuous low-amplitude twinkling and nebula drift
//   - no raymarching, no planets, no 3D fields, and no extra texture inputs
//
// The terminal remains authoritative. This shader replaces only background-
// like pixels and preserves source RGB and alpha for terminal content.

#define PI 3.14159265358979323846

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

mat2 rotation(float angle)
{
    float cosine = cos(angle);
    float sine = sin(angle);
    return mat2(cosine, -sine, sine, cosine);
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

float valueNoise2(vec2 point)
{
    vec2 cell = floor(point);
    vec2 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);

    return mix(
        mix(
            hash21(cell),
            hash21(cell + vec2(1.0, 0.0)),
            local.x
        ),
        mix(
            hash21(cell + vec2(0.0, 1.0)),
            hash21(cell + vec2(1.0, 1.0)),
            local.x
        ),
        local.y
    );
}

// Stars have stable pixel-space positions. Their luminance changes gently,
// but they never cross a cell boundary or reseed as time advances.
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
    vec2 local = fract(grid);
    float identity = hash21(cell + seed);
    vec2 starPosition = mix(
        vec2(0.16),
        vec2(0.84),
        vec2(
            hash21(cell + vec2(seed + 11.7, seed + 3.1)),
            hash21(cell + vec2(seed + 5.9, seed + 23.4))
        )
    );
    vec2 delta = (local - starPosition) * spacing;
    float distanceSquared = dot(delta, delta);
    float exists = smoothstep(
        threshold,
        min(threshold + 0.040, 0.999),
        identity
    );
    float sizeSeed = hash21(cell + vec2(seed + 29.4, seed - 8.6));
    float radius = mix(0.34, 1.28, pow(sizeSeed, 3.5));
    float core = exp(-distanceSquared / max(radius * radius, 0.001));

    float rare = smoothstep(0.981, 0.998, identity) * exists;
    float rayX = exp(-abs(delta.y) * 2.9 - abs(delta.x) * 0.24);
    float rayY = exp(-abs(delta.x) * 2.9 - abs(delta.y) * 0.24);
    float twinkle = 0.93
        + 0.07
            * sin(
                iTime * mix(0.07, 0.22, sizeSeed)
                    + identity * 113.0
            );
    vec3 colour = mix(
        STAR_WARM,
        STAR_COLD,
        hash21(cell + vec2(seed - 3.8, seed + 39.2))
    );

    return colour
        * exists
        * twinkle
        * (core + rare * (rayX + rayY) * 0.050)
        * intensity;
}

float segmentDistance(
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
    return length(point - (start + segment * along));
}

// Most cycles contain no meteor. A successful cycle creates one continuous
// diagonal sweep, which fades fully before the next deterministic event.
vec3 shootingStar(vec2 point)
{
    const float CYCLE_SECONDS = 17.0;
    float cycle = floor(iTime / CYCLE_SECONDS);
    float phase = fract(iTime / CYCLE_SECONDS);
    float eventSeed = hash11(cycle * 13.17 + 4.1);
    float eventExists = smoothstep(0.63, 0.82, eventSeed);
    float life = smoothstep(0.11, 0.17, phase)
        * (1.0 - smoothstep(0.40, 0.54, phase))
        * eventExists;
    float travel = saturate((phase - 0.11) / 0.38);

    vec2 start = vec2(
        mix(-0.76, 0.36, hash11(cycle * 7.1 + 2.3)),
        mix(0.30, 0.72, hash11(cycle * 11.7 + 8.4))
    );
    vec2 direction = normalize(vec2(
        mix(0.58, 0.92, hash11(cycle * 3.7 + 6.2)),
        mix(-0.64, -0.36, hash11(cycle * 17.9 + 1.3))
    ));
    vec2 head = start + direction * travel * 1.18;
    float tailLength = mix(
        0.10,
        0.24,
        hash11(cycle * 5.9 + 9.7)
    );
    vec2 tailStart = head - direction * tailLength;
    float along;
    float distanceToTrail = segmentDistance(point, tailStart, head, along);
    float trailWidth = mix(0.0020, 0.0065, 1.0 - along);
    float trail = exp(-distanceToTrail / trailWidth)
        * pow(along, 1.35);
    float headGlow = exp(
        -dot(point - head, point - head) / 0.000028
    );
    float flare = 0.82
        + 0.18
            * sin(
                iTime * 18.0
                    + eventSeed * 51.0
            );
    vec3 colour = mix(
        STAR_COLD,
        STAR_WARM,
        hash11(cycle * 19.3 + 2.7)
    );

    return colour * life * flare * (trail * 0.72 + headGlow * 1.35);
}

// Used only to place a narrow contrast contour around default foreground
// glyphs. It never modifies terminal RGB directly.
float foregroundCoverage(vec2 uv)
{
    vec3 sourceDelta = texture(
        iChannel0,
        clamp(uv, 0.0, 1.0)
    ).rgb - iBackgroundColor;
    vec3 foregroundDelta = iForegroundColor - iBackgroundColor;
    float foregroundEnergy = max(
        dot(foregroundDelta, foregroundDelta),
        0.0001
    );
    float coverage = saturate(
        dot(sourceDelta, foregroundDelta) / foregroundEnergy
    );
    float colourResidual = length(
        sourceDelta - foregroundDelta * coverage
    );
    float defaultForeground = 1.0
        - smoothstep(0.025, 0.100, colourResidual);
    return coverage * defaultForeground;
}

// cursor-blaze shades the background before this shader sees it. Projecting
// onto the configured background colour treats that small neutral change as
// background, without losing ANSI colours, selections, or cursor content.
float terminalInk(vec3 colour)
{
    float backgroundEnergy = max(
        dot(iBackgroundColor, iBackgroundColor),
        0.0001
    );
    float backgroundScale = dot(colour, iBackgroundColor)
        / backgroundEnergy;
    vec3 fittedBackground = iBackgroundColor * backgroundScale;
    float chromaDistance = length(colour - fittedBackground);
    float chromaInk = smoothstep(0.012, 0.060, chromaDistance);
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
    vec2 point = (fragCoord - resolution * 0.5) / resolution.y;

    // A pair of inexpensive value-noise layers describes a faint diagonal
    // Milky Way. The dark lane gives it depth while keeping terminal output
    // substantially darker than the foreground text.
    vec2 nebulaDrift = vec2(
        sin(iTime * 0.0038),
        cos(iTime * 0.0027)
    ) * 0.15;
    vec2 nebulaPoint = rotation(-0.22) * point;
    float broadGas = valueNoise2(nebulaPoint * 1.75 + nebulaDrift);
    float fineGas = valueNoise2(
        nebulaPoint * 5.40
            + vec2(broadGas * 1.8, -broadGas)
            + nebulaDrift * 1.6
    );
    float milkyWay = exp(
        -abs(
            nebulaPoint.y
                + nebulaPoint.x * 0.28
                - 0.010
                + (broadGas - 0.50) * 0.19
        ) * 3.8
    );
    float dustLane = exp(
        -abs(
            nebulaPoint.y
                + nebulaPoint.x * 0.28
                + (fineGas - 0.50) * 0.050
        ) * 28.0
    );

    vec3 scene = SPACE_BLACK;
    scene += DEEP_BLUE * (0.10 + broadGas * 0.18);
    scene += mix(NEBULA_VIOLET, NEBULA_CYAN, fineGas)
        * milkyWay
        * (0.150 + fineGas * 0.270);
    scene *= 1.0 - dustLane * milkyWay * 0.24;
    vec2 galacticCoreOffset = nebulaPoint - vec2(-0.26, 0.12);
    float galacticCore = exp(
        -dot(
            galacticCoreOffset * vec2(1.00, 1.55),
            galacticCoreOffset * vec2(1.00, 1.55)
        ) * 5.0
    );
    scene += mix(NEBULA_VIOLET, NEBULA_CYAN, broadGas)
        * galacticCore
        * (0.030 + fineGas * 0.045);
    scene += starLayer(fragCoord, 17.0, 0.935, 3.2, 0.28);
    scene += starLayer(fragCoord, 36.0, 0.850, 11.7, 0.82);
    scene += starLayer(fragCoord, 86.0, 0.740, 47.3, 1.08);
    scene += starLayer(fragCoord, 188.0, 0.700, 93.1, 0.74);
    scene += shootingStar(point);

    // A gentle filmic curve keeps stars crisp and preserves deep blacks
    // without clipping the occasional meteor into an opaque white segment.
    scene = vec3(1.0) - exp(-max(scene, vec3(0.0)) * 1.16);
    float vignette = saturate(
        1.0 - dot(point * vec2(0.45, 0.70), point * vec2(0.45, 0.70))
    );
    scene *= mix(0.84, 1.0, vignette);

    // Most pixels avoid all neighbour sampling. The four samples run only
    // around bright stars or a meteor, where a local contour aids reading.
    float sceneLuminance = dot(scene, vec3(0.2126, 0.7152, 0.0722));
    float brightScene = smoothstep(0.36, 0.68, sceneLuminance);
    if (brightScene > 0.0) {
        vec2 pixel = 1.0 / resolution;
        float centreCoverage = foregroundCoverage(uv);
        float neighbourCoverage = max(
            foregroundCoverage(uv + vec2(pixel.x, 0.0)),
            foregroundCoverage(uv - vec2(pixel.x, 0.0))
        );
        neighbourCoverage = max(
            neighbourCoverage,
            foregroundCoverage(uv + vec2(0.0, pixel.y))
        );
        neighbourCoverage = max(
            neighbourCoverage,
            foregroundCoverage(uv - vec2(0.0, pixel.y))
        );
        float contour = saturate(
            neighbourCoverage - centreCoverage * 0.92
        );
        scene *= 1.0 - contour * brightScene * 0.28;
    }

    vec3 colour = mix(scene, source.rgb, terminalInk(source.rgb));
    fragColor = vec4(clamp(colour, 0.0, 1.0), source.a);
}
