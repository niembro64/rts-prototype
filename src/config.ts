/**
 * Global Game Configuration
 *
 * Adjust these values to tune gameplay, networking, and audio.
 */

// =============================================================================
// ECONOMY & COSTS
// =============================================================================

/**
 * Multiplier applied to all unit and building energy costs.
 * 1.0 = normal costs, 2.0 = double costs, 3.0 = triple costs
 */
export const COST_MULTIPLIER = 3.0;

// =============================================================================
// NETWORKING
// =============================================================================

/**
 * How many times per second the host broadcasts game state to clients.
 * Higher = smoother but more bandwidth. Lower = choppier but less bandwidth.
 *
 * Recommended: 10-30
 * - 10: Low bandwidth, noticeable delay
 * - 20: Good balance (default)
 * - 30: Smooth but higher bandwidth
 */
export const NETWORK_UPDATES_PER_SECOND = 3;

/**
 * Calculated interval in milliseconds between network updates.
 */
export const NETWORK_UPDATE_INTERVAL_MS = 1000 / NETWORK_UPDATES_PER_SECOND;

// =============================================================================
// AUDIO
// =============================================================================

/**
 * Enable or disable the continuous laser beam sound effect.
 * Set to false if the laser sound is annoying or causing issues.
 */
export const LASER_SOUND_ENABLED = false;

// =============================================================================
// GAMEPLAY
// =============================================================================

/**
 * Starting energy stockpile for each player.
 */
export const STARTING_STOCKPILE = 1000;

/**
 * Maximum energy stockpile capacity.
 */
export const MAX_STOCKPILE = 1000;

/**
 * Base energy income per second (before solar panels).
 */
export const BASE_INCOME_PER_SECOND = 10;

// =============================================================================
// NETWORK UPDATE EXPLANATION
// =============================================================================
/**
 * ## How Multiplayer Updates Work
 *
 * ### Host (authoritative server):
 * - Runs the full game simulation at 60 FPS (fixed timestep)
 * - Processes all commands from all players
 * - Every NETWORK_UPDATE_INTERVAL_MS (default: 50ms = 20/sec), broadcasts:
 *   - All entity positions, rotations, HP
 *   - Projectile positions and beam coordinates
 *   - Economy state for all players
 *   - Audio events (fire, hit, death, laser sounds)
 *   - Spray targets (build/heal effects)
 *   - Game over state
 *
 * ### Clients (display only):
 * - Do NOT run the simulation
 * - Receive full game state from host 20x/sec
 * - Reconstruct entities from network data
 * - Render based on received state
 * - Send only COMMANDS to host:
 *   - Move commands
 *   - Attack commands
 *   - Build commands
 *   - Production queue commands
 *   - etc.
 *
 * ### Data Flow:
 * ```
 * Client Input → Command → Host
 * Host Simulation → State → All Clients
 * ```
 *
 * ### What's Sent (Host → Clients):
 * - NetworkGameState (~1-10KB depending on entity count):
 *   - tick: number
 *   - entities[]: id, type, x, y, rotation, hp, etc.
 *   - economy: stockpile, income for each player
 *   - audioEvents[]: sounds to play
 *   - sprayTargets[]: build/heal effects
 *   - gameOver?: winner info
 *
 * ### What's Sent (Client → Host):
 * - Commands (~50-200 bytes each):
 *   - type: 'move' | 'select' | 'build' | etc.
 *   - entityIds: which units
 *   - target position or entity
 */
