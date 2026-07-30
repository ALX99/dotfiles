// STELLAR DYNAMICS
//
// A continuous, physics-informed procedural star for Ghostty:
//
//   - a true spherical photosphere with quadratic limb darkening
//   - seamless 3D convection carried by latitude-dependent rotation
//   - fixed sunspot groups and faculae anchored in stellar coordinates
//   - an optically thin, five-sample corona with magnetic streamers
//   - tapered plasma prominences rooted at the stellar limb
//   - a phase-lit rocky companion on an inclined eccentric orbit
//   - rare, continuous coronal mass ejections and physical moon transits
//   - a stable star field: no time wrapping, reseeding, or positional popping
//
// This is not a fluid simulation, but every moving structure has a continuous
// coordinate system and a physical role. The scene replaces only Ghostty's
// configured background pixels; terminal content remains authoritative, with
// local contrast protection where bright glyphs cross the photosphere.

#define PI 3.14159265358979323846

const vec3 SPACE_BLACK = vec3(0.0015, 0.0030, 0.0070);
const vec3 DEEP_NAVY = vec3(0.012, 0.027, 0.058);
const vec3 NEBULA_INDIGO = vec3(0.052, 0.024, 0.115);
const vec3 NEBULA_BLUE = vec3(0.012, 0.092, 0.150);

const vec3 COLD_STAR = vec3(0.520, 0.760, 1.000);
const vec3 WARM_STAR = vec3(1.000, 0.700, 0.410);

const vec3 SPOT_UMBRA = vec3(0.120, 0.018, 0.004);
const vec3 PHOTOSPHERE_ORANGE = vec3(1.000, 0.220, 0.018);
const vec3 PHOTOSPHERE_GOLD = vec3(1.000, 0.620, 0.185);
const vec3 PHOTOSPHERE_WHITE = vec3(1.000, 0.940, 0.700);
const vec3 PROMINENCE_RED = vec3(0.650, 0.035, 0.004);
const vec3 CORONA_WHITE = vec3(0.720, 0.850, 1.000);
const vec3 MOON_SHADOW = vec3(0.006, 0.009, 0.014);
const vec3 MOON_ROCK = vec3(0.210, 0.235, 0.250);
const vec3 MOON_DUST = vec3(0.570, 0.555, 0.510);

float saturate(float value)
{
    return clamp(value, 0.0, 1.0);
}

float terminalAlphaAt(vec2 uv)
{
    vec3 sampleDelta = texture(
        iChannel0,
        clamp(uv, 0.0, 1.0)
    ).rgb - iBackgroundColor;
    vec3 foregroundDelta = iForegroundColor - iBackgroundColor;
    float foregroundEnergy = max(
        dot(foregroundDelta, foregroundDelta),
        0.0001
    );
    return saturate(
        dot(sampleDelta, foregroundDelta) / foregroundEnergy
    );
}

float hash21(vec2 value)
{
    vec3 p3 = fract(vec3(value.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float hash31(vec3 value)
{
    value = fract(value * 0.1031);
    value += dot(value, value.yzx + 33.33);
    return fract((value.x + value.y) * value.z);
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

float fieldNoise2(vec2 point)
{
    float value = valueNoise2(point) * 0.57;
    point = mat2(0.80, 0.60, -0.60, 0.80) * point * 2.03 + 7.1;
    value += valueNoise2(point) * 0.28;
    point = mat2(0.72, -0.69, 0.69, 0.72) * point * 2.11 + 3.7;
    value += valueNoise2(point) * 0.15;
    return value;
}

float valueNoise3(vec3 point)
{
    vec3 cell = floor(point);
    vec3 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);

    float lowerNear = mix(
        hash31(cell),
        hash31(cell + vec3(1.0, 0.0, 0.0)),
        local.x
    );
    float upperNear = mix(
        hash31(cell + vec3(0.0, 1.0, 0.0)),
        hash31(cell + vec3(1.0, 1.0, 0.0)),
        local.x
    );
    float lowerFar = mix(
        hash31(cell + vec3(0.0, 0.0, 1.0)),
        hash31(cell + vec3(1.0, 0.0, 1.0)),
        local.x
    );
    float upperFar = mix(
        hash31(cell + vec3(0.0, 1.0, 1.0)),
        hash31(cell + vec3(1.0, 1.0, 1.0)),
        local.x
    );

    return mix(
        mix(lowerNear, upperNear, local.y),
        mix(lowerFar, upperFar, local.y),
        local.z
    );
}

float fieldNoise3(vec3 point)
{
    float value = valueNoise3(point) * 0.53;
    point = point * 2.03 + vec3(17.1, 7.7, 3.2);
    value += valueNoise3(point) * 0.27;
    point = point.yzx * 2.07 + vec3(5.3, 19.1, 11.7);
    value += valueNoise3(point) * 0.135;
    point = point.zxy * 2.11 + vec3(13.7, 3.9, 23.4);
    value += valueNoise3(point) * 0.065;
    return value;
}

vec3 rotateY(vec3 point, float angle)
{
    float cosine = cos(angle);
    float sine = sin(angle);
    return vec3(
        cosine * point.x + sine * point.z,
        point.y,
        -sine * point.x + cosine * point.z
    );
}

vec3 rotateZ(vec3 point, float angle)
{
    float cosine = cos(angle);
    float sine = sin(angle);
    return vec3(
        cosine * point.x - sine * point.y,
        sine * point.x + cosine * point.y,
        point.z
    );
}

// Stable pixel-space stars. They do not translate; only their radiance changes
// by a low-amplitude continuous sinusoid.
vec3 stellarLayer(
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
        vec2(0.18),
        vec2(0.82),
        vec2(
            hash21(cell + vec2(seed + 13.7, seed + 2.1)),
            hash21(cell + vec2(seed + 5.3, seed + 19.9))
        )
    );

    vec2 delta = (local - starPosition) * spacing;
    float distanceSquared = dot(delta, delta);
    float existence = smoothstep(
        threshold,
        min(threshold + 0.045, 0.999),
        identity
    );
    float sizeSeed = hash21(cell + vec2(seed + 31.4, seed - 7.6));
    float radius = mix(0.42, 1.42, pow(sizeSeed, 4.0));
    float core = exp(-distanceSquared / max(radius * radius, 0.001));

    float rareStar = smoothstep(0.976, 0.998, identity) * existence;
    float distanceToStar = sqrt(distanceSquared);
    float halo = exp(-distanceToStar * 0.46) * rareStar;
    float horizontalRay = exp(-abs(delta.y) * 2.4)
        * exp(-abs(delta.x) * 0.21);
    float verticalRay = exp(-abs(delta.x) * 2.4)
        * exp(-abs(delta.y) * 0.21);
    float diffraction = (horizontalRay + verticalRay) * rareStar;

    float temperature = hash21(cell + vec2(seed - 4.8, seed + 41.2));
    vec3 color = mix(WARM_STAR, COLD_STAR, temperature);
    float twinkle = 0.91
        + 0.09
            * sin(
                iTime * mix(0.08, 0.21, sizeSeed)
                    + identity * 113.0
            );

    return color
        * existence
        * twinkle
        * (core * 0.88 + halo * 0.070 + diffraction * 0.060)
        * intensity;
}

// Fixed sunspot groups in co-rotating 3D coordinates. Dot products give a
// seam-free angular distance on the sphere.
vec2 spotGroup(vec3 surfacePoint, vec3 centre, float size)
{
    float angularDistance = 1.0 - dot(surfacePoint, normalize(centre));
    float penumbra = exp(-angularDistance * size);
    float umbra = exp(-angularDistance * size * 3.1);
    return vec2(penumbra, umbra);
}

// Five fixed line-of-sight samples approximate optically thin coronal
// emission. Broad lobes follow a slowly precessing magnetic axis.
vec2 coronalEmission(vec2 impact, float time)
{
    float magneticPhase = time * 0.0045;
    vec3 magneticAxis = normalize(vec3(
        sin(0.31) * cos(magneticPhase),
        cos(0.31),
        sin(0.31) * sin(magneticPhase)
    ));

    float emission = 0.0;
    float hotStreamers = 0.0;
    for (int sampleIndex = 0; sampleIndex < 5; sampleIndex++) {
        float rayDepth = (float(sampleIndex) - 2.0) * 0.82;
        vec3 samplePoint = vec3(impact, rayDepth);
        float radius = max(length(samplePoint), 1.001);
        vec3 direction = samplePoint / radius;

        float density = exp(-(radius - 1.0) * 1.10)
            / (radius * radius);
        float magneticLatitude = abs(dot(direction, magneticAxis));
        float polarStreamer = pow(magneticLatitude, 9.0);
        float equatorialSheet = pow(1.0 - magneticLatitude, 15.0);
        float structure = 0.30
            + polarStreamer * 2.25
            + equatorialSheet * 0.58;
        float sampleWeight = 1.0 - abs(rayDepth) * 0.12;

        emission += density * density * structure * sampleWeight;
        hotStreamers += density
            * polarStreamer
            * sampleWeight;
    }

    return vec2(emission * 0.27, hotStreamers * 0.22);
}

// A tapered, magnetically guided plasma prominence. The spine bends through
// continuous waves; no state is created, destroyed, or reseeded per frame.
vec2 plasmaProminence(
    vec2 fromStar,
    float starRadius,
    float angle,
    float prominenceLength,
    float baseWidth,
    float phase
)
{
    vec2 outward = vec2(cos(angle), sin(angle));
    vec2 tangent = vec2(-outward.y, outward.x);
    float axialDistance = dot(fromStar, outward) - starRadius * 0.90;
    float lateralDistance = dot(fromStar, tangent);
    float rawProgress = axialDistance / prominenceLength;
    float progress = saturate(rawProgress);

    float magneticBend = (
        sin(progress * 4.7 - iTime * 0.19 + phase)
            + sin(progress * 10.3 + iTime * 0.11 + phase * 1.7) * 0.34
    );
    magneticBend *= baseWidth * (0.12 + progress * progress * 1.35);

    float localWidth = baseWidth
        * mix(1.0, 0.18, progress)
        * (
            0.88
                + sin(progress * 8.0 - iTime * 0.13 + phase) * 0.12
        );
    float distanceToSpine = abs(lateralDistance - magneticBend);
    float core = exp(
        -distanceToSpine / max(localWidth, 0.0001)
    );
    float glow = exp(
        -distanceToSpine / max(baseWidth * 3.2, 0.0001)
    );

    float root = smoothstep(-0.04, 0.035, rawProgress);
    float tip = 1.0 - smoothstep(0.68, 1.02, rawProgress);
    float longitudinalFlow = 0.72
        + 0.28
            * sin(
                progress * 18.0
                    - iTime * 0.47
                    + phase
            );
    float massLoading = 0.76
        + sin(iTime * 0.071 + phase) * 0.16
        + sin(iTime * 0.037 + phase * 2.3) * 0.08;

    return vec2(
        core * root * tip * longitudinalFlow * massLoading,
        glow * root * tip * massLoading
    );
}

// A rare, magnetic coronal mass ejection: a widening shell and a thinner,
// hotter current sheet launched from one persistent active longitude. The
// sinusoidal launch gate is continuous at both birth and decay, so the shell
// has faded away before its analytic trajectory returns to the base.
vec2 coronalMassEjection(
    vec2 fromStar,
    float starRadius,
    float angle,
    float phase
)
{
    float cycleAngle = iTime * 0.014 + phase;
    float cycleHeight = 0.5 + 0.5 * sin(cycleAngle);
    float risingMotion = cos(cycleAngle);
    float launch = smoothstep(0.69, 0.93, cycleHeight);
    float decay = smoothstep(-0.30, 0.08, risingMotion);
    float event = launch * decay;

    vec2 outward = vec2(cos(angle), sin(angle));
    vec2 tangent = vec2(-outward.y, outward.x);
    float axialDistance = dot(fromStar, outward);
    float lateralDistance = dot(fromStar, tangent);
    float front = starRadius * mix(1.10, 5.10, launch);
    float fanWidth = starRadius * mix(0.09, 0.82, launch);
    float bentAxis = sin(
        axialDistance / starRadius * 2.3 - iTime * 0.10 + phase
    ) * fanWidth * 0.17;
    float shellDistance = abs(axialDistance - front);
    float shell = exp(
        -shellDistance / max(starRadius * 0.11, 0.0001)
    ) * exp(
        -abs(lateralDistance - bentAxis) / max(fanWidth, 0.0001)
    );

    float sheetWidth = starRadius
        * mix(0.025, 0.080, launch)
        * (0.92 + sin(iTime * 0.31 + phase) * 0.08);
    float currentSheet = exp(
        -abs(lateralDistance - bentAxis)
            / max(sheetWidth, 0.0001)
    );
    float rooted = smoothstep(
        starRadius * 0.72,
        starRadius * 1.08,
        axialDistance
    );
    float beforeFront = 1.0 - smoothstep(
        front,
        front + starRadius * 0.28,
        axialDistance
    );
    float texture = 0.72
        + 0.28
            * sin(
                axialDistance / starRadius * 12.0
                    - iTime * 0.41
                    + phase
            );

    return vec2(
        shell * event,
        currentSheet * rooted * beforeFront * texture * event
    );
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 resolution = iResolution.xy;
    vec2 uv = fragCoord / resolution;
    vec4 source = texture(iChannel0, uv);
    vec2 point = (fragCoord - resolution * 0.5) / resolution.y;

    // A slowly evolving dust band. Bounded sinusoidal offsets avoid precision
    // loss during long-running terminal sessions.
    vec2 nebulaDrift = vec2(
        sin(iTime * 0.0031),
        cos(iTime * 0.0023)
    ) * 0.18;
    float dust = fieldNoise2(point * 2.05 + nebulaDrift);
    float bandCentre = point.y
        + point.x * 0.22
        - 0.055
        + (dust - 0.5) * 0.12;
    float nebulaEnvelope = exp(-abs(bandCentre) * 4.7);
    float nebulaFilament = pow(
        0.5
            + 0.5
                * sin(
                    point.x * 3.4
                        - point.y * 2.7
                        + dust * 5.1
                ),
        3.0
    );

    vec3 scene = SPACE_BLACK;
    scene += DEEP_NAVY * (0.065 + dust * 0.145);
    scene += mix(NEBULA_INDIGO, NEBULA_BLUE, nebulaFilament)
        * nebulaEnvelope
        * (0.055 + dust * 0.130);

    float darkLane = exp(
        -abs(bandCentre + 0.040 + sin(point.x * 3.8) * 0.014) * 27.0
    );
    scene *= 1.0 - darkLane * nebulaEnvelope * 0.19;

    // Static positions eliminate the cell-boundary popping caused by moving
    // procedural star grids. Different scales still establish visual depth.
    scene += stellarLayer(fragCoord, 30.0, 0.880, 11.7, 0.82);
    scene += stellarLayer(fragCoord, 72.0, 0.795, 47.3, 1.14);

    const vec2 STAR_CENTRE = vec2(0.285, 0.005);
    const float BASE_RADIUS = 0.073;
    vec2 fromStar = point - STAR_CENTRE;
    float distanceFromStar = length(fromStar);

    // Real stars oscillate, but photospheric p-modes are tiny. Keep geometric
    // motion below one percent and let convection carry the visible animation.
    float stellarOscillation = 1.0
        + sin(iTime * 0.41) * 0.0018
        + sin(iTime * 0.67 + 1.8) * 0.0009;
    float starRadius = BASE_RADIUS * stellarOscillation;
    float normalizedRadius = distanceFromStar / starRadius;
    float antialias = max(fwidth(normalizedRadius), 0.004);
    float disc = 1.0 - smoothstep(
        1.0 - antialias,
        1.0 + antialias,
        normalizedRadius
    );

    // Integrate the corona only near the star. It is occluded by the opaque
    // photosphere later.
    vec2 corona = vec2(0.0);
    if (normalizedRadius < 7.0) {
        corona = coronalEmission(fromStar / starRadius, iTime);
    }
    vec3 coronaColor = mix(
        PHOTOSPHERE_GOLD,
        CORONA_WHITE,
        saturate(corona.y)
    );
    scene += coronaColor
        * corona.x
        * (1.0 - disc)
        * 0.52;

    // A low-density radial falloff supplies the faint outer solar wind that
    // the finite line-of-sight samples intentionally miss.
    float solarWind = exp(-max(normalizedRadius - 1.0, 0.0) * 0.56)
        / max(normalizedRadius * normalizedRadius, 1.0);
    scene += mix(PHOTOSPHERE_GOLD, CORONA_WHITE, 0.46)
        * solarWind
        * (1.0 - disc)
        * 0.075;

    // Three long-lived prominences occupy fixed active latitudes. Their
    // waviness, flow, and mass loading vary continuously and independently.
    float slowAdvection = iTime * 0.0062;
    vec2 prominenceA = plasmaProminence(
        fromStar,
        starRadius,
        0.58 + slowAdvection + sin(iTime * 0.011) * 0.035,
        starRadius * 1.75,
        starRadius * 0.105,
        0.7
    );
    vec2 prominenceB = plasmaProminence(
        fromStar,
        starRadius,
        2.62 + slowAdvection * 0.72 + sin(iTime * 0.009) * 0.028,
        starRadius * 1.12,
        starRadius * 0.082,
        3.2
    );
    vec2 prominenceC = plasmaProminence(
        fromStar,
        starRadius,
        -1.05 + slowAdvection * 0.53,
        starRadius * 0.88,
        starRadius * 0.070,
        5.4
    );
    vec2 prominence = prominenceA
        + prominenceB * 0.78
        + prominenceC * 0.62;
    scene += PROMINENCE_RED
        * prominence.y
        * (1.0 - disc)
        * 0.16;
    scene += mix(
        PHOTOSPHERE_ORANGE,
        PHOTOSPHERE_WHITE,
        saturate(prominence.x * 0.48)
    ) * prominence.x * (1.0 - disc) * 0.70;

    // A single long-period CME gives the corona occasional drama without
    // constantly competing with the terminal. It grows, detaches, and fades
    // over roughly a minute; the next launch is several minutes later.
    vec2 cme = coronalMassEjection(
        fromStar,
        starRadius,
        -2.36 + sin(iTime * 0.004) * 0.055,
        1.9
    );
    scene += mix(PHOTOSPHERE_ORANGE, PHOTOSPHERE_GOLD, cme.x)
        * cme.x
        * (1.0 - disc)
        * 0.34;
    scene += mix(PHOTOSPHERE_GOLD, CORONA_WHITE, cme.y * 0.72)
        * cme.y
        * (1.0 - disc)
        * 0.48;

    // Surface evaluation uses a true visible hemisphere. All texture and spot
    // coordinates are three-dimensional, so there is no wrapped-longitude seam.
    vec3 surfaceRadiance = vec3(0.0);
    if (normalizedRadius < 1.02) {
        vec2 spherePlane = fromStar / starRadius;
        float viewDepth = sqrt(
            max(1.0 - dot(spherePlane, spherePlane), 0.0)
        );
        vec3 viewNormal = normalize(vec3(spherePlane, viewDepth));
        vec3 tiltedNormal = rotateZ(viewNormal, -0.19);

        float latitude = asin(clamp(tiltedNormal.y, -1.0, 1.0));
        float sinLatitude = sin(latitude);
        float angularVelocity = 0.030
            * (1.0 - 0.18 * sinLatitude * sinLatitude);
        vec3 stellarCoordinate = rotateY(
            tiltedNormal,
            -iTime * angularVelocity
        );

        // Slowly moving domains represent evolving convection while remaining
        // tied to the co-rotating stellar surface.
        vec3 convectionDrift = vec3(
            sin(iTime * 0.017),
            cos(iTime * 0.013),
            sin(iTime * 0.011 + 1.2)
        ) * 0.32;
        float convection = fieldNoise3(
            stellarCoordinate * 5.2 + convectionDrift
        );
        float granulation = fieldNoise3(
            stellarCoordinate * 17.5
                + convectionDrift * 1.8
                + vec3(convection * 2.1)
        );
        float intergranularLanes = smoothstep(0.30, 0.66, granulation);
        float temperature = saturate(
            0.30
                + convection * 0.34
                + intergranularLanes * 0.38
        );

        vec2 spotA = spotGroup(
            stellarCoordinate,
            vec3(0.72, 0.23, 0.65),
            72.0
        );
        vec2 spotB = spotGroup(
            stellarCoordinate,
            vec3(-0.58, -0.31, 0.75),
            88.0
        );
        vec2 spotC = spotGroup(
            stellarCoordinate,
            vec3(0.18, -0.48, -0.86),
            105.0
        );
        float penumbra = saturate(
            spotA.x + spotB.x * 0.84 + spotC.x * 0.68
        );
        float umbra = saturate(
            spotA.y + spotB.y * 0.92 + spotC.y * 0.72
        );
        float facula = max(penumbra - umbra, 0.0);

        // Quadratic limb darkening with coefficients close to a visible-light
        // solar approximation.
        float mu = saturate(viewDepth);
        float oneMinusMu = 1.0 - mu;
        float limbDarkening = 1.0
            - 0.48 * oneMinusMu
            - 0.18 * oneMinusMu * oneMinusMu;

        vec3 plasmaColor = mix(
            PHOTOSPHERE_GOLD,
            PHOTOSPHERE_WHITE,
            0.28 + temperature * 0.62
        );
        float granularRadiance = mix(
            0.90,
            1.11,
            intergranularLanes
        );
        surfaceRadiance = plasmaColor
            * limbDarkening
            * granularRadiance
            * 1.78;
        surfaceRadiance += PHOTOSPHERE_WHITE
            * facula
            * (0.08 + oneMinusMu * 0.32);
        surfaceRadiance = mix(
            surfaceRadiance,
            SPOT_UMBRA * (0.42 + temperature * 0.20),
            saturate(penumbra * 0.50 + umbra * 0.48)
        );
    }

    // The photosphere is opaque; foreground prominences were clipped to its
    // exterior, and the corona cannot shine through it.
    scene = mix(scene, surfaceRadiance, disc);

    // A small rocky companion follows a mildly eccentric Keplerian orbit.
    // Two Newton-free correction terms approximate eccentric anomaly closely
    // at this low eccentricity, producing natural acceleration near periapsis.
    const float ORBIT_RADIUS = 0.235;
    const float ORBIT_ECCENTRICITY = 0.16;
    // A nearly edge-on viewing angle creates one real foreground transit per
    // orbit. The opposite conjunction passes behind the photosphere.
    const float ORBIT_INCLINATION = 1.34;
    const float ORBIT_PERIAPSIS = 0.37;
    float meanAnomaly = iTime * 0.036 + 1.1;
    float eccentricAnomaly = meanAnomaly
        + ORBIT_ECCENTRICITY * sin(meanAnomaly)
        + ORBIT_ECCENTRICITY
            * ORBIT_ECCENTRICITY
            * 0.5
            * sin(meanAnomaly * 2.0);
    vec2 orbitPlane = vec2(
        ORBIT_RADIUS
            * (cos(eccentricAnomaly) - ORBIT_ECCENTRICITY),
        ORBIT_RADIUS
            * sqrt(
                1.0
                    - ORBIT_ECCENTRICITY
                        * ORBIT_ECCENTRICITY
            )
            * sin(eccentricAnomaly)
    );
    float periapsisCosine = cos(ORBIT_PERIAPSIS);
    float periapsisSine = sin(ORBIT_PERIAPSIS);
    orbitPlane = mat2(
        periapsisCosine,
        -periapsisSine,
        periapsisSine,
        periapsisCosine
    ) * orbitPlane;

    // Positive Z points toward the viewer. The same coordinate determines
    // apparent scale, illumination phase, and whether the star occults it.
    vec3 orbitPosition = vec3(
        orbitPlane.x,
        orbitPlane.y * cos(ORBIT_INCLINATION),
        orbitPlane.y * sin(ORBIT_INCLINATION)
    );
    vec2 moonCentre = STAR_CENTRE + orbitPosition.xy;
    float moonRadius = 0.0092
        * (
            1.0
                + orbitPosition.z
                    / ORBIT_RADIUS
                    * 0.075
        );
    vec2 moonPlane = (point - moonCentre) / moonRadius;
    float moonRadial = length(moonPlane);
    float moonAntialias = max(fwidth(moonRadial), 0.018);
    float moonDisc = 1.0 - smoothstep(
        1.0 - moonAntialias,
        1.0 + moonAntialias,
        moonRadial
    );

    vec3 moonRadiance = MOON_SHADOW;
    if (moonRadial < 1.04) {
        float moonDepth = sqrt(
            max(1.0 - dot(moonPlane, moonPlane), 0.0)
        );
        vec3 moonNormal = normalize(vec3(moonPlane, moonDepth));
        vec3 moonCoordinate = rotateY(
            moonNormal,
            -iTime * 0.021
        );

        float highlands = fieldNoise3(
            moonCoordinate * 5.8 + vec3(2.4, -7.1, 3.8)
        );
        float fineRegolith = fieldNoise3(
            moonCoordinate * 15.0 + vec3(-5.7, 1.9, 9.3)
        );
        float craterBasins = smoothstep(0.64, 0.79, highlands)
            * (1.0 - smoothstep(0.74, 0.88, fineRegolith));
        vec3 albedo = mix(
            MOON_ROCK,
            MOON_DUST,
            highlands * 0.58 + fineRegolith * 0.18
        );
        albedo *= 1.0 - craterBasins * 0.34;

        vec3 directionToStar = normalize(-orbitPosition);
        float diffuseLight = max(
            dot(moonNormal, directionToStar),
            0.0
        );
        float softTerminator = smoothstep(0.0, 0.16, diffuseLight);
        float reflectedLight = 0.020
            + diffuseLight * softTerminator * 0.82;
        float limbFalloff = 0.72 + moonDepth * 0.28;
        vec3 stellarTint = mix(
            PHOTOSPHERE_GOLD,
            PHOTOSPHERE_WHITE,
            diffuseLight * 0.42
        );

        moonRadiance = albedo
            * stellarTint
            * reflectedLight
            * limbFalloff
            * 1.45;
    }

    // Behind the star, only overlapping pixels are hidden. In front, the
    // companion naturally becomes a dim transit silhouette because its lit
    // hemisphere faces away from the viewer.
    float behindStar = smoothstep(
        -0.012,
        0.012,
        -orbitPosition.z
    );
    float orbitalVisibility = 1.0 - disc * behindStar;
    scene = mix(
        scene,
        moonRadiance,
        moonDisc * orbitalVisibility
    );

    // Gentle exponential tone mapping preserves stellar radiance without
    // clipping the surface into a flat yellow circle.
    scene = vec3(1.0) - exp(-max(scene, vec3(0.0)));

    float grain = hash21(floor(fragCoord)) - 0.5;
    scene += grain * 0.0016;

    float sourceDifference = length(source.rgb - iBackgroundColor);
    float ink = smoothstep(0.025, 0.180, sourceDifference);

    // Preserve the terminal's original glyph color and add only a narrow
    // background outline where the photosphere would wash it out. Estimating
    // glyph coverage from the configured foreground color keeps antialiased
    // edges from becoming bright halos when the background is replaced.
    vec2 pixel = 1.0 / resolution;
    float outlineMask = max(
        terminalAlphaAt(uv + vec2(pixel.x * 0.85, 0.0)),
        terminalAlphaAt(uv + vec2(-pixel.x * 0.85, 0.0))
    );
    outlineMask = max(
        outlineMask,
        terminalAlphaAt(uv + vec2(0.0, pixel.y * 0.85))
    );
    outlineMask = max(
        outlineMask,
        terminalAlphaAt(uv + vec2(0.0, -pixel.y * 0.85))
    );
    outlineMask = max(
        outlineMask,
        terminalAlphaAt(uv + vec2(pixel.x, pixel.y))
    );
    outlineMask = max(
        outlineMask,
        terminalAlphaAt(uv + vec2(-pixel.x, pixel.y))
    );
    outlineMask = max(
        outlineMask,
        terminalAlphaAt(uv + vec2(pixel.x, -pixel.y))
    );
    outlineMask = max(
        outlineMask,
        terminalAlphaAt(uv + vec2(-pixel.x, -pixel.y))
    );
    float sceneLuminance = dot(scene, vec3(0.2126, 0.7152, 0.0722));
    float brightScene = smoothstep(0.30, 0.68, sceneLuminance);
    scene = mix(
        scene,
        scene * 0.16,
        outlineMask * brightScene * 0.45
    );
    vec3 color = mix(scene, source.rgb, ink);

    fragColor = vec4(clamp(color, 0.0, 1.0), source.a);
}
