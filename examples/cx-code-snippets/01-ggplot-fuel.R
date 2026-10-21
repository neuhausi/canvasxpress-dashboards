# title: Fuel efficiency vs. weight (ggplot2)
# source: ggplot2
library(ggplot2)
g <- ggplot(mtcars, aes(x = wt, y = mpg, color = factor(cyl))) +
  geom_point(size = 2) +
  labs(x = "Weight (1000 lbs)", y = "MPG", color = "Cylinders")
