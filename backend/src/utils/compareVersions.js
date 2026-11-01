/**
 * Hand-rolled X.Y.Z version comparator — no `semver` package. It appears
 * only as a transitive lockfile entry elsewhere in this repo (another
 * tool's own dependency, never imported by any source file here), so
 * pulling it in for a ~10-line comparison would be an unnecessary
 * dependency. No pre-release/build-metadata support — plain three-integer
 * versions only, matching what admins are expected to enter (see
 * routes/adminVersionsRoutes.js's validation).
 *
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const partA = partsA[i] ?? 0;
    const partB = partsB[i] ?? 0;
    if (partA < partB) return -1;
    if (partA > partB) return 1;
  }
  return 0;
}
