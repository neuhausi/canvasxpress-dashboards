# title: Quarterly revenue by region (R canvasXpress)
# source: canvasXpress (R)
library(canvasXpress)
y <- matrix(c(42, 55, 61, 70, 38, 47, 52, 63), nrow = 2, byrow = TRUE,
            dimnames = list(c("West", "East"), c("Q1", "Q2", "Q3", "Q4")))
g <- canvasXpress(data = y, graphType = "Bar",
                  title = "Quarterly revenue by region",
                  xAxisTitle = "Revenue ($M)")
