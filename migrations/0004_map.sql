-- VEMI-004 decisions 6 and 27: the map keeps where he put a venture.
--
-- Decision 6 is "layout suggests, he adjusts, the position stays", and an adjustment that
-- does not survive a reload is not an adjustment. Additive and nullable on the same terms
-- as decision 24's board columns: three nulls mean never moved, and `placeVentures` puts
-- the venture wherever the suggested layout puts it until the day it is dragged.
--
-- Three numbers and not two because the map is a sphere seen through a camera. A venture
-- dragged across the screen has to keep its depth, or it would drift toward or away from
-- the eye every time the map turned.
--
-- Map units, not pixels. Nothing on this surface is measured in pixels: the unit the map
-- draws at is solved each frame to hold everything in the view.

-- deprecated by 0016, dropped in proof: map_x, map_y and map_z (the account keeps positions in canvas_pos).
ALTER TABLE venture ADD COLUMN map_x REAL;
ALTER TABLE venture ADD COLUMN map_y REAL;
ALTER TABLE venture ADD COLUMN map_z REAL;
