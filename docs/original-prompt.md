# Original Project Prompt

This document preserves the original project prompt that started the sales forecasting AI proof of concept.

> I've just created this project to start a proof of concept, but I'd like to confirm some ideas on architecture, first.
> The overall goal is to have a basic webapp which helps demonstrate the use of AI in sales forecasting.
> The plan is to implement it into an ERP so that my customers can reference my tooling for recommendations on how best to prepare for the upcoming sales season.
>
> My customers upload their own sales forecasts as a CSV, which we should provide as a template that the user fills out with their data.
> Minimally, it's a pivot table where:
> - Y axis: product names/codes/titles
> - X axis: months--typically starting with the current one, and ideally going out for about a year forward.
>
> The accuracy and requirements here are not really important, since this is a POC and we aren't really storing a lot of data for later reference.
>
> The POC part of this, though, is how I'd like to integrate AI into this.
> Generally, I'd consider a salesforecast to be a form of impossible future-telling. Anybody can get close, but it's largely a seasonally-informed guess!
>
> After a forecast is uploaded, of course I'd like to visualize it as a table, and I'd like to select a product in the table to visualize as a line graph.
> And in this exploration view, I'd like a button I can click: "AI-Assisted Forecasting" which will provide me with insights that go beyond my own considerations that could impect my forecasts.
>
> When I click this button, I'd like a takeover modal to show up, informing me how to use it.
> I should explain how my forecasting works, and what considerations I took in making my predictions.
> Optionally, this is the opportunity I have to include particular details that I realize are in my blindspot, and I specifically would like consideration in those areas.
>
> And upon submission, I wait for an async AI task to finish, which will go month-by-month, product-by-product on my forecast to fetch possible influential factors that I should consider in my forecast.
> Maybe these factors are numerable and directly tie into dollar-impact. Maybe they're impossible to quantify, but they're important to at least keep in mind when placing orders!
> What my usr would be looking for from this enhancement are "here are real items that you didn't consider which will impact your sales for month X" and "here are some out-of-the box recommendations which may  enhance your sales, if you wanted to lean into them and help your numbers."
>
> These suggestions may be enhanced with some extra information or metadata about the products listed, provided by the user.
> That's something we can expect in the CSV as optional information, and include it in the template.
> Metadata that describes more about the product than can be conveyed by the name alone.
>
> For example, one of my products may be a perfume.
> Including the name alone may be informative enough to help an agent look up what the product is, how it's been marketed in the past, and if those marketing concepts are getting popular again independently--like a famous actor-partner launching a new movie; their popularity may impact sales positively.
> Something that may not be easy to find is that perhaps the liquid is a very fine amber color; that could be included as descriptive info/metadata. And if Amber or something close is the color of the year, maybe that's something worth leaning into! A suggestion to improve sales!
> And perhaps, if I mention that it's sold in Minnesota, and this month, there's been political unrest in the state, next month may still be negatively impacted due to the affiliation.
>
> Something along those lines.
>
> Once these findings are found, the agent should report their findings in a normalized structure:
>
> - product ID (string)
> - month-year (string isoformatted)
> - considerations (array[object(description:str, impact:int)])
> - recommendations (array[object(description:str, impact:int)])
>
> These values can be pushed into a database, and a polling frontend can show them to the user!
>
> I imagine this is something that I can build as a FastAPI application with HTMX or Lit serving the frontend, as I'd really like to focus on the backend and minimize any bootstrapping or frontend complexity.
> I can get by with a basic sqlite database to bootstrap this as well--no need for docker or anything.
>
> Where I'm open to recommendation is in the agentic AI side of things.
> My gut says that there's a specific API endpoint thatI'd have for kickstarting the AI feature as a background job, with whatever extra context from the user...
> I'd think it's some structured prompt which has is hydrated with the user's product data, which we fetch from the database, and then kick off to an agent integration, which provides our desired structured output?
> Is there an implementation pattern which is more standard?
> Let's get started with an implementation plan.
> I'd like this to be in a `docs/` directory in this project, and any diagrams to be made using mermaid.
