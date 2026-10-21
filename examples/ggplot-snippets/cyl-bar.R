# title: Count of cars by cylinders
g <- ggplot(mtcars, aes(x = factor(cyl), fill = factor(cyl))) +
  geom_bar() +
  labs(x = "Cylinders", y = "Count")
