Namespace intapi

    Public Interface IOpenAISettings
        Property OPENAI_MODEL As String
        Property OPENAI_API_KEY As String
    End Interface

    Public Class OpenAISettings
        Implements IOpenAISettings
        Public Sub New()

        End Sub
        Public Property OPENAI_MODEL As String Implements IOpenAISettings.OPENAI_MODEL
        Public Property OPENAI_API_KEY As String Implements IOpenAISettings.OPENAI_API_KEY
    End Class

End Namespace