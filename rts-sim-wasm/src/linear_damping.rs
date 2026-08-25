#[inline]
pub(crate) fn linear_damping_rate_from_coefficient(
    linear_drag_coefficient: f64,
    inv_mass: f64,
) -> f64 {
    if !linear_drag_coefficient.is_finite()
        || linear_drag_coefficient <= 0.0
        || !inv_mass.is_finite()
        || inv_mass <= 0.0
    {
        return 0.0;
    }
    linear_drag_coefficient * inv_mass
}

#[inline]
pub(crate) fn integrate_linear_damping_axis(
    pos: &mut f64,
    vel: &mut f64,
    accel: f64,
    dt_sec: f64,
    linear_damping_rate: f64,
    medium_velocity: f64,
) {
    if !dt_sec.is_finite() || dt_sec <= 0.0 {
        return;
    }
    if !linear_damping_rate.is_finite() || linear_damping_rate <= 1e-9 {
        *pos += *vel * dt_sec + 0.5 * accel * dt_sec * dt_sec;
        *vel += accel * dt_sec;
        return;
    }
    let damp = (-linear_damping_rate * dt_sec).exp();
    let retention_loss = 1.0 - damp;
    if !damp.is_finite() || !retention_loss.is_finite() {
        return;
    }
    let terminal = medium_velocity + accel / linear_damping_rate;
    *pos += (*vel - terminal) * retention_loss / linear_damping_rate + terminal * dt_sec;
    *vel = *vel * damp + terminal * retention_loss;
}
