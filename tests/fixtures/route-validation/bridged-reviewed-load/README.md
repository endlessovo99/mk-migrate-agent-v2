# Reviewed bridged load visibility

This source has multiple selector change callbacks that write hidden helper
values and row visibility, plus separate load callbacks that restore the rows.
The display binding is intentionally unproven, so load scripts require review;
source-backed bridge rules are initially retained. Once a reviewed load action
is proven to preserve its corresponding source row effects, it and the
verified change action own subsequent visibility. A separate native load rule
uses an inert, generated hidden field to initialize the source-proven hidden
state even when the preview skips onLoad. It never reacts to selector changes.
Other load rules remain intact until their own review succeeds.
